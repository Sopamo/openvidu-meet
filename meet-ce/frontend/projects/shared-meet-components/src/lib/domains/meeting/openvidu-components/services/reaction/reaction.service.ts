import { inject, Injectable, signal } from '@angular/core';
import { AssetsService } from '../../../../../shared/services/assets.service';
import { ILogger } from '../../models/logger.model';
import { DataTopic } from '../../models/data-topic.model';
import { ActiveReaction, MeetingReaction, REACTIONS, ReactionSignalPayload } from '../../models/reaction.model';
import { LoggerService } from '../logger/logger.service';
import { ParticipantService } from '../participant/participant.service';

/**
 * @internal
 *
 * comeet: meeting reactions (Google Meet style). A reaction is sent to everyone over the data channel,
 * floats up on every screen with the sender's name and plays a short, quiet sound.
 */
@Injectable({
	providedIn: 'root'
})
export class ReactionService {
	/** How long a reaction floats on screen (ms, before randomisation). */
	static readonly DURATION = 4000;
	/** Minimum gap between two reactions sent by this user (ms). */
	private static readonly SEND_INTERVAL = 350;
	/** At most this many reactions on screen; older ones are dropped. */
	private static readonly MAX_ON_SCREEN = 30;
	/** Minimum gap between two reaction sounds (ms), so bursts don't turn into noise. */
	private static readonly SOUND_INTERVAL = 600;
	/** Reaction sounds are mixed well below speech (the files are at about -20 LUFS, like a voice). */
	private static readonly SOUND_GAIN = 0.3;
	/** Treble above this is filtered out, which takes the edge off the effects. */
	private static readonly SOUND_LOWPASS_HZ = 3500;
	/** Sounds are faded out over this long, ending at most SOUND_MAX_S after they start. */
	private static readonly SOUND_FADE_S = 0.35;
	private static readonly SOUND_MAX_S = 1.1;

	private readonly log: ILogger = inject(LoggerService).get('ReactionService');
	private readonly participantService = inject(ParticipantService);
	private readonly assets = inject(AssetsService);

	private readonly _active = signal<ActiveReaction[]>([]);
	/** Reactions currently floating on screen. */
	readonly active = this._active.asReadonly();

	private key = 0;
	private lastSent = 0;
	private lastSound = 0;
	private audioContext?: AudioContext;
	/** Decoded sound effects, loaded on first use. */
	private readonly sounds = new Map<string, Promise<AudioBuffer | undefined>>();

	/** Send a reaction to everyone (and show it locally). */
	async send(id: string): Promise<void> {
		const reaction = REACTIONS.find((r) => r.id === id);
		const now = Date.now();
		if (!reaction || now - this.lastSent < ReactionService.SEND_INTERVAL) return;
		this.lastSent = now;
		this.show(reaction, this.participantService.getMyName() ?? '', true);
		try {
			const payload: ReactionSignalPayload = { reaction: id };
			const data = new TextEncoder().encode(JSON.stringify(payload));
			await this.participantService.publishData(data, { topic: DataTopic.REACTION, reliable: true });
		} catch (error) {
			this.log.e('Error sending reaction:', error);
		}
	}

	/** A reaction from another participant arrived. Unknown reaction ids are ignored. */
	receive(payload: ReactionSignalPayload, participantName: string): void {
		const reaction = REACTIONS.find((r) => r.id === payload?.reaction);
		if (reaction) this.show(reaction, participantName, false);
	}

	private show(reaction: MeetingReaction, participantName: string, isLocal: boolean): void {
		const duration = ReactionService.DURATION + Math.round(Math.random() * 800);
		const item: ActiveReaction = {
			key: ++this.key,
			reaction,
			participantName,
			isLocal,
			offset: Math.round(Math.random() * 140),
			duration
		};
		this._active.update((list) => [...list, item].slice(-ReactionService.MAX_ON_SCREEN));
		setTimeout(() => this._active.update((list) => list.filter((r) => r.key !== item.key)), duration);
		this.playSound(reaction);
	}

	private playSound(reaction: MeetingReaction): void {
		const now = Date.now();
		if (now - this.lastSound < ReactionService.SOUND_INTERVAL) return;
		this.lastSound = now;
		try {
			const context = (this.audioContext ??= new AudioContext());
			if (context.state === 'suspended') void context.resume();
			void this.loadSound(context, reaction).then((buffer) => {
				if (!buffer) return;
				const source = context.createBufferSource();
				source.buffer = buffer;
				const filter = context.createBiquadFilter();
				filter.type = 'lowpass';
				filter.frequency.value = ReactionService.SOUND_LOWPASS_HZ;
				const gain = context.createGain();
				const t0 = context.currentTime;
				const end = t0 + Math.min(buffer.duration, ReactionService.SOUND_MAX_S);
				gain.gain.setValueAtTime(ReactionService.SOUND_GAIN, t0);
				gain.gain.setValueAtTime(ReactionService.SOUND_GAIN, Math.max(t0, end - ReactionService.SOUND_FADE_S));
				gain.gain.linearRampToValueAtTime(0, end);
				source.connect(filter).connect(gain).connect(context.destination);
				source.start(t0);
				source.stop(end);
			});
		} catch (error) {
			this.log.w('Could not play reaction sound', error);
		}
	}

	private loadSound(context: AudioContext, reaction: MeetingReaction): Promise<AudioBuffer | undefined> {
		let sound = this.sounds.get(reaction.id);
		if (!sound) {
			sound = fetch(this.assets.reactionAsset(reaction.sound))
				.then((response) => response.arrayBuffer())
				.then((data) => context.decodeAudioData(data))
				.catch((error) => {
					this.log.w(`Could not load reaction sound ${reaction.sound}`, error);
					this.sounds.delete(reaction.id);
					return undefined;
				});
			this.sounds.set(reaction.id, sound);
		}
		return sound;
	}
}
