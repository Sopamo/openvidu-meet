import { computed, inject, Injectable, signal } from '@angular/core';
import { StorageKeys } from '../../models/storage.model';
import { StorageService } from '../storage/storage.service';

/**
 * @internal
 *
 * Local playback volume for each remote participant, chosen by the local user.
 *
 * It only changes what this user hears (nothing is sent to the room) and is remembered in
 * `localStorage`, keyed by participant identity. Signed-in users keep the same identity across
 * meetings, so a volume set once applies to that person in every later meeting.
 *
 * Values are gain factors: 0 = silent, 1 = unchanged (the default, not stored), up to
 * {@link ParticipantVolumeService.MAX} to boost quiet speakers (audio is mixed through Web Audio,
 * which allows gains above 1).
 */
@Injectable({
	providedIn: 'root'
})
export class ParticipantVolumeService {
	static readonly MAX = 2;
	static readonly STEP = 0.05;

	private readonly storage = inject(StorageService);
	private readonly _volumes = signal<Record<string, number>>(this.storage.getParticipantVolumes());

	/** All customised volumes, keyed by participant identity. */
	readonly volumes = this._volumes.asReadonly();

	constructor() {
		// Keep tabs of the same browser in step (e.g. two meetings open at once).
		window.addEventListener('storage', (event) => {
			if (event.key?.endsWith(StorageKeys.PARTICIPANT_VOLUMES)) {
				this._volumes.set(this.storage.getParticipantVolumes());
			}
		});
	}

	/** Volume for a participant identity (1 if never changed). */
	volumeOf(identity: string): number {
		return this._volumes()[identity] ?? 1;
	}

	/** Reactive variant of {@link volumeOf} for templates and computed signals. */
	volumeSignal(identity: string) {
		return computed(() => this.volumeOf(identity));
	}

	setVolume(identity: string, volume: number): void {
		const clamped = Math.min(ParticipantVolumeService.MAX, Math.max(0, volume));
		const rounded = Math.round(clamped / ParticipantVolumeService.STEP) * ParticipantVolumeService.STEP;
		const next = { ...this._volumes() };
		if (Math.abs(rounded - 1) < 1e-9) {
			delete next[identity];
		} else {
			next[identity] = Number(rounded.toFixed(2));
		}
		this._volumes.set(next);
		this.storage.setParticipantVolumes(next);
	}

	resetVolume(identity: string): void {
		this.setVolume(identity, 1);
	}
}
