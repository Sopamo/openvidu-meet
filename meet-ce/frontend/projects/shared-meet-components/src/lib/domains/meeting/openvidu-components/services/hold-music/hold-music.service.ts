import { inject, Injectable, signal } from '@angular/core';
import { AssetsService } from '../../../../../shared/services/assets.service';
import { ILogger } from '../../models/logger.model';
import { LoggerService } from '../logger/logger.service';
import { StorageService } from '../storage/storage.service';

/**
 * @internal
 *
 * comeet: quiet "hold" music while you are alone in a meeting. The tracks (generated with ElevenLabs Music,
 * loudness-normalised) are played in random order, crossfading into each other; the music fades out as soon as someone else joins and
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
	/** Consecutive tracks overlap by this long, one fading out while the next fades in. */
	private static readonly CROSSFADE_MS = 4000;

	private readonly log: ILogger = inject(LoggerService).get('HoldMusicService');
	private readonly storage = inject(StorageService);
	private readonly assets = inject(AssetsService);

	private readonly _enabled = signal(this.storage.getHoldMusic());
	/** Whether hold music plays while the user is alone in a meeting. */
	readonly enabled = this._enabled.asReadonly();

	private alone = false;
	/** The track playing now (during a crossfade: the one fading in). */
	private audio?: HTMLAudioElement;
	private last = -1;
	private readonly fades = new Map<HTMLAudioElement, ReturnType<typeof setInterval>>();
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
		this.playNext(HoldMusicService.FADE_IN_MS);
	}

	/** Starts a random track (not the previous one), fading in over `fadeMs`. */
	private playNext(fadeMs: number): void {
		const tracks = HoldMusicService.TRACKS;
		let i = Math.floor(Math.random() * tracks.length);
		if (tracks.length > 1 && i === this.last) i = (i + 1) % tracks.length;
		this.last = i;
		const audio = new Audio(this.assets.resolve(`assets/sounds/hold/${tracks[i]}`));
		audio.volume = 0;
		// CROSSFADE_MS before the end, the next track fades in while this one fades out.
		const onTime = () => {
			if (this.audio !== audio || !isFinite(audio.duration)) return;
			if (audio.duration - audio.currentTime > HoldMusicService.CROSSFADE_MS / 1000) return;
			audio.removeEventListener('timeupdate', onTime);
			this.fadeOut(audio, HoldMusicService.CROSSFADE_MS);
			this.audio = undefined;
			this.playNext(HoldMusicService.CROSSFADE_MS);
		};
		audio.addEventListener('timeupdate', onTime);
		// Fallback if no timeupdate came in time (background tab): next track right away
		audio.addEventListener('ended', () => {
			this.fadeOut(audio, 0);
			if (this.audio !== audio) return;
			this.audio = undefined;
			this.playNext(HoldMusicService.FADE_IN_MS);
		});
		this.audio = audio;
		audio
			.play()
			.then(() => this.fadeTo(audio, HoldMusicService.VOLUME, fadeMs))
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
		this.audio = undefined;
		// Everything still playing, including a track fading out in a crossfade
		for (const audio of [...this.fades.keys()]) this.fadeOut(audio, HoldMusicService.FADE_OUT_MS);
	}

	private fadeOut(audio: HTMLAudioElement, ms: number): void {
		this.fadeTo(audio, 0, ms, () => {
			audio.pause();
			audio.removeAttribute('src');
			audio.load();
		});
	}

	/** Ramps the volume; the element stays in `fades` until it has been faded out and released. */
	private fadeTo(audio: HTMLAudioElement, target: number, ms: number, done?: () => void): void {
		clearInterval(this.fades.get(audio));
		const from = audio.volume;
		const start = performance.now();
		const timer = setInterval(() => {
			const k = ms > 0 ? Math.min(1, (performance.now() - start) / ms) : 1;
			audio.volume = from + (target - from) * k;
			if (k < 1) return;
			clearInterval(timer);
			if (done) {
				this.fades.delete(audio);
				done();
			}
		}, 40);
		this.fades.set(audio, timer);
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
