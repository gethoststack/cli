import { apiFetch } from '../lib/api.ts';
import { getTeamId } from '../lib/config.ts';
import { formatDate } from '../lib/format.ts';
import {
	bold,
	dim,
	green,
	handleError,
	red,
	spinner,
	statusBadge,
	table,
	yellow,
} from '../lib/output.ts';

// Hetzner block-volume bounds. Kept in sync with HETZNER_BLOCK_VOLUME_MIN_GB /
// HETZNER_BLOCK_VOLUME_MAX_GB in packages/shared/src/constants/pricing.ts —
// the API rejects anything outside [10, 10240]. The CLI is a standalone
// published package with no @hoststack/shared dependency, so these are
// duplicated here intentionally.
const VOLUME_MIN_GB = 10;
const VOLUME_MAX_GB = 10240;

interface Volume {
	id: number;
	publicId: string;
	name: string;
	mountPath: string;
	sizeGb: number;
	status: string;
	backupEnabled: boolean;
	/** Hetzner block storage: already triple-replicated, so backups are refused. */
	blockBacked: boolean;
	/** An infra machine's own Docker volume, mounted in place. Size is not ours. */
	adopted: boolean;
	createdAt: string;
	updatedAt: string;
}

/**
 * What the Backups column says.
 *
 * `off` used to be printed for a volume where `on` is not reachable at all — a
 * block-backed one, where the API refuses the toggle — which reads as a setting
 * nobody got round to rather than as an answer. `n/a` is "there is nothing to
 * turn on here"; `off` is "you have not turned it on".
 */
function backupsCell(v: Volume): string {
	if (v.blockBacked) return dim('n/a');
	return v.backupEnabled ? green('on') : red('off');
}

/** One archive of this volume that reached object storage — a point to restore to. */
interface RestorePoint {
	id: number;
	archiveName: string;
	sizeBytes: number | null;
	createdAt: string;
}

export async function volumesCommand(args: string[]): Promise<void> {
	const subcommand = args[0] ?? 'list';

	switch (subcommand) {
		case 'list':
		case 'ls':
			return listVolumes(args.slice(1));
		case 'create':
		case 'add':
			return createVolume(args.slice(1));
		case 'resize':
			return resizeVolume(args.slice(1));
		case 'backups':
			return listBackups(args.slice(1));
		case 'backup':
			return setBackup(args.slice(1));
		case 'restore':
			return restoreVolume(args.slice(1));
		case 'delete':
		case 'rm':
			return deleteVolume(args.slice(1));
		default:
			console.log(`${bold('Usage:')} hoststack volumes <command>`);
			console.log();
			console.log('Commands:');
			console.log(
				'  list <service-id>                          List volumes attached to a service',
			);
			console.log(
				'  create <service-id> <name> <mount-path> [--size N]  Attach a new volume',
			);
			console.log(
				'  resize <service-id> <volume-id> <size-gb>  Grow a volume (cannot shrink)',
			);
			console.log(
				'  delete <service-id> <volume-id>            Detach and deprovision a volume',
			);
			console.log(
				'  backup <service-id> <volume-id> on|off     Turn nightly backups on or off',
			);
			console.log(
				'  backups <service-id> <volume-id>           List the archives you can restore from',
			);
			console.log(
				'  restore <service-id> <volume-id> <backup-id>  Unpack an archive over the volume',
			);
			console.log();
			console.log(
				dim('  Backups are block-level tars of a LIVE disk — crash consistent, not'),
			);
			console.log(
				dim('  application consistent. For a container running its own database, take'),
			);
			console.log(dim('  a dump as well; this is the disaster fallback, not a substitute.'));
			console.log(
				dim('  A volume marked (adopted) is one HostStack mounts but does not own:'),
			);
			console.log(
				dim('  backups can be turned on — they only read it — but resize, restore'),
			);
			console.log(dim('  and delete are refused.'));
			process.exit(1);
	}
}

async function listVolumes(args: string[]): Promise<void> {
	const teamId = getTeamId();
	if (!teamId) {
		console.error(red('No team selected. Run: hoststack login --key <api-key>'));
		process.exit(1);
	}
	const serviceId = args[0];
	if (!serviceId) {
		console.log(`${bold('Usage:')} hoststack volumes list <service-id> [--json]`);
		process.exit(1);
	}

	const jsonFlag = args.includes('--json');

	try {
		const response = await apiFetch<{ volumes: Volume[] }>(
			`/api/services/${teamId}/${serviceId}/volumes`,
		);
		const volumes = response.volumes;

		if (jsonFlag) {
			console.log(JSON.stringify(volumes, null, 2));
			return;
		}

		if (volumes.length === 0) {
			console.log(
				dim(
					`No volumes attached to service ${serviceId}. Create one with: hoststack volumes create ${serviceId} <name> <mount-path>`,
				),
			);
			return;
		}

		console.log(
			table(
				['ID', 'Name', 'Mount Path', 'Size (GB)', 'Status', 'Backups', 'Created'],
				volumes.map((v) => [
					v.publicId,
					// Plain text, not dim(): the column is padded by string
					// length, so an escape sequence in one row's cell and not in
					// another's is what makes a table stop lining up.
					v.adopted ? `${v.name} (adopted)` : v.name,
					v.mountPath,
					// An adopted volume has no size of ours — HostStack did not
					// provision it — and the column's way of saying so was to
					// print 0, which reads as a volume with no space in it.
					v.adopted ? 'n/a' : String(v.sizeGb),
					statusBadge(v.status),
					backupsCell(v),
					formatDate(v.createdAt),
				]),
			),
		);
	} catch (err) {
		handleError(err);
	}
}

async function createVolume(args: string[]): Promise<void> {
	const teamId = getTeamId();
	if (!teamId) {
		console.error(red('No team selected. Run: hoststack login --key <api-key>'));
		process.exit(1);
	}
	const serviceId = args[0];
	const name = args[1];
	const mountPath = args[2];
	if (!serviceId || !name || !mountPath) {
		console.log(
			`${bold('Usage:')} hoststack volumes create <service-id> <name> <mount-path> [--size N (10-10240, default 10)]`,
		);
		process.exit(1);
	}

	const sizeIdx = args.indexOf('--size');
	const sizeGb =
		sizeIdx >= 0 && args[sizeIdx + 1] ? Number.parseInt(args[sizeIdx + 1]!, 10) : VOLUME_MIN_GB;
	if (Number.isNaN(sizeGb) || sizeGb < VOLUME_MIN_GB || sizeGb > VOLUME_MAX_GB) {
		console.error(
			red(`--size must be an integer between ${VOLUME_MIN_GB} and ${VOLUME_MAX_GB}`),
		);
		process.exit(1);
	}

	const s = spinner(`Attaching volume "${name}" (${sizeGb}GB) at ${mountPath}...`);
	try {
		const response = await apiFetch<{ volume: Volume }>(
			`/api/services/${teamId}/${serviceId}/volumes`,
			{
				method: 'POST',
				body: JSON.stringify({ name, mountPath, sizeGb }),
			},
		);
		s.stop(`Attached volume ${response.volume.publicId}`);
		console.log(
			`${bold('Attached')} volume ${response.volume.publicId} (${sizeGb}GB) at ${mountPath}.`,
		);
		console.log(dim('It will mount on the next deploy.'));
	} catch (err) {
		s.stop(red('Failed'));
		handleError(err);
	}
}

async function resizeVolume(args: string[]): Promise<void> {
	const teamId = getTeamId();
	if (!teamId) {
		console.error(red('No team selected. Run: hoststack login --key <api-key>'));
		process.exit(1);
	}
	const serviceId = args[0];
	const volumeId = args[1];
	const sizeStr = args[2];
	if (!serviceId || !volumeId || !sizeStr) {
		console.log(
			`${bold('Usage:')} hoststack volumes resize <service-id> <volume-id> <size-gb>`,
		);
		process.exit(1);
	}
	const sizeGb = Number.parseInt(sizeStr, 10);
	if (Number.isNaN(sizeGb) || sizeGb < VOLUME_MIN_GB || sizeGb > VOLUME_MAX_GB) {
		console.error(
			red(`size-gb must be an integer between ${VOLUME_MIN_GB} and ${VOLUME_MAX_GB}`),
		);
		process.exit(1);
	}

	const s = spinner(`Resizing ${volumeId} to ${sizeGb}GB...`);
	try {
		await apiFetch(`/api/services/${teamId}/${serviceId}/volumes/${volumeId}`, {
			method: 'PATCH',
			body: JSON.stringify({ sizeGb }),
		});
		s.stop(`Resized → ${sizeGb}GB`);
		console.log(`${bold('Resized')} volume ${volumeId} → ${sizeGb}GB.`);
	} catch (err) {
		s.stop(red('Failed'));
		handleError(err);
	}
}

async function deleteVolume(args: string[]): Promise<void> {
	const teamId = getTeamId();
	if (!teamId) {
		console.error(red('No team selected. Run: hoststack login --key <api-key>'));
		process.exit(1);
	}
	const serviceId = args[0];
	const volumeId = args[1];
	if (!serviceId || !volumeId) {
		console.log(`${bold('Usage:')} hoststack volumes delete <service-id> <volume-id>`);
		process.exit(1);
	}

	const s = spinner(`Deprovisioning volume ${volumeId}...`);
	try {
		await apiFetch(`/api/services/${teamId}/${serviceId}/volumes/${volumeId}`, {
			method: 'DELETE',
		});
		s.stop('Deleted');
		console.log(
			`${bold('Deleted')} volume ${volumeId}. Disk will be removed by the host agent.`,
		);
	} catch (err) {
		s.stop(red('Failed'));
		handleError(err);
	}
}

/** Bytes → a size a human reads at a glance. `null` when the agent reported none. */
function formatBytes(bytes: number | null): string {
	if (bytes === null) return dim('—');
	const units = ['B', 'KB', 'MB', 'GB', 'TB'];
	let value = bytes;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit++;
	}
	return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

/**
 * Turn nightly backups on or off for a volume.
 *
 * `backupEnabled` has always been readable and, outside the dashboard,
 * unsettable — so "turn on backups for this disk" was a click, not a command,
 * on exactly the volumes most likely to be the only copy of a customer's data.
 */
async function setBackup(args: string[]): Promise<void> {
	const teamId = getTeamId();
	if (!teamId) {
		console.error(red('No team selected. Run: hoststack login --key <api-key>'));
		process.exit(1);
	}
	const serviceId = args[0];
	const volumeId = args[1];
	const mode = args[2];
	if (!serviceId || !volumeId || (mode !== 'on' && mode !== 'off')) {
		console.log(`${bold('Usage:')} hoststack volumes backup <service-id> <volume-id> on|off`);
		process.exit(1);
	}

	const enable = mode === 'on';
	const s = spinner(`Turning backups ${mode} for ${volumeId}...`);
	try {
		await apiFetch(`/api/services/${teamId}/${serviceId}/volumes/${volumeId}`, {
			method: 'PATCH',
			body: JSON.stringify({ backupEnabled: enable }),
		});
		s.stop(enable ? green('Backups on') : yellow('Backups off'));
		if (enable) {
			// Enabling is a schedule, not a backup. Say when to expect one, and
			// how to confirm it exists, because "backupEnabled: true" with
			// nothing behind it is worse than knowing you have none.
			console.log(
				`${bold('Backups on')} for ${volumeId}. The first archive is taken on the next nightly run.`,
			);
			console.log(
				dim(`Confirm one exists: hoststack volumes backups ${serviceId} ${volumeId}`),
			);
			console.log(
				dim('These are block-level tars of a live disk (crash consistent). If this volume'),
			);
			console.log(
				dim('holds a database, schedule a dump too — a tar of a mid-write datadir'),
			);
			console.log(dim('restores like a power cut, and that is not always recoverable.'));
		} else {
			console.log(
				`${bold('Backups off')} for ${volumeId}. Existing archives are kept; no new ones are taken.`,
			);
		}
	} catch (err) {
		s.stop(red('Failed'));
		handleError(err);
	}
}

/** The archives this volume can actually be restored from. */
async function listBackups(args: string[]): Promise<void> {
	const teamId = getTeamId();
	if (!teamId) {
		console.error(red('No team selected. Run: hoststack login --key <api-key>'));
		process.exit(1);
	}
	const serviceId = args[0];
	const volumeId = args[1];
	if (!serviceId || !volumeId) {
		console.log(
			`${bold('Usage:')} hoststack volumes backups <service-id> <volume-id> [--json]`,
		);
		process.exit(1);
	}
	const jsonFlag = args.includes('--json');

	try {
		const { restorePoints } = await apiFetch<{ restorePoints: RestorePoint[] }>(
			`/api/services/${teamId}/${serviceId}/volumes/${volumeId}/restore-points`,
		);

		if (jsonFlag) {
			console.log(JSON.stringify(restorePoints, null, 2));
			return;
		}

		if (restorePoints.length === 0) {
			// The distinction that matters: "backups are on" and "a backup
			// exists" are different claims, and only this one is about recovery.
			console.log(yellow(`No restore points for volume ${volumeId}.`));
			console.log(
				dim('  If backups are on, either none has completed yet, or the host cannot'),
			);
			console.log(
				dim('  upload off-site and is writing its tar onto the disk it is backing up.'),
			);
			console.log(dim(`  Check the flag: hoststack volumes list ${serviceId}`));
			return;
		}

		console.log(
			table(
				['ID', 'Archive', 'Size', 'Taken'],
				restorePoints.map((p) => [
					String(p.id),
					p.archiveName,
					formatBytes(p.sizeBytes),
					formatDate(p.createdAt),
				]),
			),
		);
		console.log();
		console.log(
			dim(`Restore one: hoststack volumes restore ${serviceId} ${volumeId} <backup-id>`),
		);
	} catch (err) {
		handleError(err);
	}
}

/**
 * Unpack an archive over a volume's contents.
 *
 * Destructive and irreversible, so it refuses to run on a bare id: the operator
 * has to name the archive they mean with `--yes`, after seeing its timestamp.
 */
async function restoreVolume(args: string[]): Promise<void> {
	const teamId = getTeamId();
	if (!teamId) {
		console.error(red('No team selected. Run: hoststack login --key <api-key>'));
		process.exit(1);
	}
	const serviceId = args[0];
	const volumeId = args[1];
	const backupIdRaw = args[2];
	if (!serviceId || !volumeId || !backupIdRaw) {
		console.log(
			`${bold('Usage:')} hoststack volumes restore <service-id> <volume-id> <backup-id> --yes`,
		);
		console.log();
		console.log(dim('  List ids with: hoststack volumes backups <service-id> <volume-id>'));
		process.exit(1);
	}
	const backupId = Number.parseInt(backupIdRaw, 10);
	if (Number.isNaN(backupId)) {
		console.error(red(`backup-id must be a number (got "${backupIdRaw}").`));
		process.exit(1);
	}

	let point: RestorePoint | undefined;
	try {
		const { restorePoints } = await apiFetch<{ restorePoints: RestorePoint[] }>(
			`/api/services/${teamId}/${serviceId}/volumes/${volumeId}/restore-points`,
		);
		point = restorePoints.find((p) => p.id === backupId);
		if (!point) {
			console.error(red(`Backup ${backupId} is not a restore point for volume ${volumeId}.`));
			console.error(dim(`  List them: hoststack volumes backups ${serviceId} ${volumeId}`));
			process.exit(1);
		}
	} catch (err) {
		handleError(err);
	}

	// Show what is about to be overwritten, then require the flag. A restore has
	// no undo — nothing snapshots the current contents first — so the timestamp
	// being visible before the irreversible step is the whole safeguard.
	console.log(`${bold('About to restore')} volume ${volumeId} on service ${serviceId}:`);
	console.log(`  ${dim('archive')} ${point.archiveName}`);
	console.log(
		`  ${dim('taken  ')} ${formatDate(point.createdAt)} (${formatBytes(point.sizeBytes)})`,
	);
	console.log();
	console.log(
		red("This REPLACES the volume's current contents. There is no undo and no snapshot"),
	);
	console.log(red('of the present state is taken first.'));
	console.log(dim('The archive is a tar of a live disk: a database inside it comes back as it'));
	console.log(dim('would after a power cut, and may run its own recovery on first start.'));

	if (!args.includes('--yes')) {
		console.log();
		console.log(`Re-run with ${bold('--yes')} to proceed.`);
		process.exit(1);
	}

	const s = spinner(`Restoring ${volumeId} from ${point.archiveName}...`);
	try {
		await apiFetch(`/api/services/${teamId}/${serviceId}/volumes/${volumeId}/restore`, {
			method: 'POST',
			body: JSON.stringify({ backupId }),
		});
		s.stop(green('Restore accepted'));
		console.log(
			`The host is unpacking ${point.archiveName} over volume ${volumeId}. Check the service once it finishes.`,
		);
	} catch (err) {
		s.stop(red('Failed'));
		handleError(err);
	}
}
