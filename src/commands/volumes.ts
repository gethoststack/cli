import { apiFetch } from '../lib/api.ts';
import { getTeamId } from '../lib/config.ts';
import { bold, dim, handleError, red, spinner, statusBadge, table } from '../lib/output.ts';

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
	createdAt: string;
	updatedAt: string;
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
				['ID', 'Name', 'Mount Path', 'Size (GB)', 'Status', 'Created'],
				volumes.map((v) => [
					v.publicId,
					v.name,
					v.mountPath,
					String(v.sizeGb),
					statusBadge(v.status),
					new Date(v.createdAt).toLocaleDateString(),
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
