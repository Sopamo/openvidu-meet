import { inject, Injectable } from '@angular/core';
import { AssetsService } from './assets.service';

/**
 * Service responsible for managing sound effects within the application.
 */
@Injectable()
export class SoundService {
	private readonly assets = inject(AssetsService);
	private audioContext?: AudioContext;
	private lastChime = 0;

	constructor() {}

	/**
	 * comeet: a soft two-note chime when someone else joins the meeting. Synthesised (two sine tones with
	 * a gentle attack and a long decay, rising a fourth), quiet enough not to interrupt the conversation.
	 * Several joins within a second chime once.
	 */
	playOtherParticipantJoinedChime(): void {
		const now = Date.now();
		if (now - this.lastChime < 1000) return;
		this.lastChime = now;
		try {
			const ctx = (this.audioContext ??= new AudioContext());
			if (ctx.state === 'suspended') void ctx.resume();
			const out = ctx.createGain();
			out.gain.value = 0.12;
			out.connect(ctx.destination);
			const t0 = ctx.currentTime + 0.02;
			// E5 then A5, each with a quiet octave partial for a bell-like tone
			[
				{ freq: 659.25, at: 0 },
				{ freq: 880, at: 0.16 }
			].forEach(({ freq, at }) => {
				[
					{ mult: 1, level: 1 },
					{ mult: 2, level: 0.18 }
				].forEach(({ mult, level }) => {
					const osc = ctx.createOscillator();
					const env = ctx.createGain();
					osc.type = 'sine';
					osc.frequency.value = freq * mult;
					const start = t0 + at;
					env.gain.setValueAtTime(0, start);
					env.gain.linearRampToValueAtTime(level, start + 0.015);
					env.gain.exponentialRampToValueAtTime(0.0001, start + 0.9);
					osc.connect(env).connect(out);
					osc.start(start);
					osc.stop(start + 0.95);
				});
			});
		} catch (error) {
			console.warn('Could not play the join chime', error);
		}
	}

	/**
	 * Plays a sound to indicate that a participant has joined the meeting.
	 */
	playParticipantJoinedSound(): void {
		const audio = new Audio(this.assets.participantJoinedSound);
		audio.volume = 0.4;
		audio.play();
	}

	/**
	 * Plays a sound to indicate that a participant's role has been upgraded.
	 */
	playParticipantRoleUpgradedSound(): void {
		const audio = new Audio(this.assets.roleUpgradedSound);
		audio.volume = 0.4;
		audio.play();
	}

	/**
	 * Plays a sound to indicate that a participant's role has been downgraded.
	 */
	playParticipantRoleDowngradedSound(): void {
		const audio = new Audio(this.assets.roleDowngradedSound);
		audio.volume = 0.4;
		audio.play();
	}
}
