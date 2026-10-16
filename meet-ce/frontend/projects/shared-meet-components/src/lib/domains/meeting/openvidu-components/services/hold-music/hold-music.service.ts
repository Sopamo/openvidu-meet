import { inject, Injectable, signal } from '@angular/core';
import { AssetsService } from '../../../../../shared/services/assets.service';
import { ILogger } from '../../models/logger.model';
import { LoggerService } from '../logger/logger.service';
import { StorageService } from '../storage/storage.service';

/**
 * @internal
 *
 * comeet: quiet "hold" music while you are alone in a meeting. The tracks (generated with ElevenLabs Music,
 * loudness-normalised) are played in random order; the music fades out as soon as someone else joins and
 * comes back when everyone else has left. Each user can switch it off (persisted in the browser).
 */
@Injectable({
	providedIn: 'root'
})
export class HoldMusicService {
	/** Files in assets/sounds/hold/. */
	static readonly TRACKS = ['hold-1.mp3', 'hold-2.mp3', 'hold-3.mp3', 'hold-4.mp3'];
	/** Playback volume: well below speech (the files are at about -20 LUFS, like a voice). */
	private static readonly VOLUME = 0.2;
	private static readonly FADE_IN_MS = 2500;
	private static readonly FADE_OUT_MS = 400;

	private readonly log: ILogger = inject(LoggerService).get('HoldMusicService');
	private readonly storage = inject(StorageService);
	private readonly assets = inject(AssetsService);

	private readonly _enabled = signal(this.storage.getHoldMusic());
	/** Whether hold music plays while the user is alone in a meeting. */
	readonly enabled = this._enabled.asReadonly();

	private alone = false;
	private audio?: HTMLAudioElement;
	private last = -1;
	private fade?: ReturnType<typeof setInterval>;
	private retryOnGesture?: () => void;

	setEnabled(enabled: boolean): void {
		this._enabled.set(enabled);
		this.storage.setHoldMusic(enabled);
		this.update();
	}

	/** Called with whether the user is the only person in the meeting (false when not in a meeting). */
	setAlone(alone: boolean): void {
		if (alone === this.alone) return;
		this.alone = alone;
		this.update();
	}

	private update(): void {
		if (this.alone && this._enabled()) this.start();
		else this.stop();
	}

	private start(): void {
		if (this.audio) return;
		this.playNext();
	}

	private playNext(): void {
		const tracks = HoldMusicService.TRACKS;
		let i = Math.floor(Math.random() * tracks.length);
		if (tracks.length > 1 && i === this.last) i = (i + 1) % tracks.length;
		this.last = i;
		const audio = new Audio(this.assets.resolve(`assets/sounds/hold/${tracks[i]}`));
		audio.volume = 0;
		// Next random track when this one ends (a different one, so it doesn't sound like a loop)
		audio.addEventListener('ended', () => {
			if (this.audio !== audio) return;
			this.audio = undefined;
			if (this.alone && this._enabled()) this.playNext();
		});
		this.audio = audio;
		audio
			.play()
			.then(() => this.fadeTo(audio, HoldMusicService.VOLUME, HoldMusicService.FADE_IN_MS))
			.catch((error) => {
				// Autoplay blocked (no user gesture yet): start with the next click or key press.
				this.log.d('Hold music blocked until the next user gesture', error);
				if (this.audio !== audio) return;
				this.audio = undefined;
				this.waitForGesture();
			});
	}

	private stop(): void {
		this.clearGestureWait();
		const audio = this.audio;
		if (!audio) return;
		this.audio = undefined;
		this.fadeTo(audio, 0, HoldMusicService.FADE_OUT_MS, () => {
			audio.pause();
			audio.removeAttribute('src');
			audio.load();
		});
	}

	private fadeTo(audio: HTMLAudioElement, target: number, ms: number, done?: () => void): void {
		if (this.fade) clearInterval(this.fade);
		const from = audio.volume;
		const start = performance.now();
		this.fade = setInterval(() => {
			const k = Math.min(1, (performance.now() - start) / ms);
			audio.volume = from + (target - from) * k;
			if (k >= 1) {
				clearInterval(this.fade);
				this.fade = undefined;
				done?.();
			}
		}, 40);
	}

	private waitForGesture(): void {
		if (this.retryOnGesture) return;
		this.retryOnGesture = () => {
			this.clearGestureWait();
			this.update();
		};
		document.addEventListener('pointerdown', this.retryOnGesture, { once: true });
		document.addEventListener('keydown', this.retryOnGesture, { once: true });
	}

	private clearGestureWait(): void {
		if (!this.retryOnGesture) return;
		document.removeEventListener('pointerdown', this.retryOnGesture);
		document.removeEventListener('keydown', this.retryOnGesture);
		this.retryOnGesture = undefined;
	}
}
