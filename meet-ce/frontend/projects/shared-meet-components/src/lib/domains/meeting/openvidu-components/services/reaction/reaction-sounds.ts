/**
 * comeet: short sound effects for meeting reactions, synthesised with Web Audio (no audio files).
 * Each reaction gets its own little sound; all are quiet and under a second.
 */

type Wave = OscillatorType;

interface Note {
	wave: Wave;
	/** Start and end frequency (Hz); different values glide between them. */
	from: number;
	to?: number;
	/** Start time and length in seconds, relative to the sound's start. */
	at: number;
	length: number;
	volume?: number;
	/** Vibrato depth in Hz (and rate in Hz). */
	vibrato?: [number, number];
	/** Exponential decay instead of a short fade at the end (bells, plucks). */
	decay?: boolean;
}

const SOUNDS: Record<string, Note[]> = {
	// boing: a wobbly rising glide
	'ugly-rotate': [{ wave: 'sine', from: 220, to: 880, at: 0, length: 0.4, vibrato: [30, 18] }],
	// party horn
	partyparrot: [
		{ wave: 'sawtooth', from: 520, to: 700, at: 0, length: 0.12, volume: 0.35 },
		{ wave: 'sawtooth', from: 700, to: 1050, at: 0.12, length: 0.3, volume: 0.35, vibrato: [15, 12] }
	],
	// happy chirp up
	'pepe-happy': [
		{ wave: 'triangle', from: 659, at: 0, length: 0.11 },
		{ wave: 'triangle', from: 880, at: 0.11, length: 0.11 },
		{ wave: 'triangle', from: 1175, at: 0.22, length: 0.18 }
	],
	// sad trombone: wah wah wah waaah
	'pepe-sad': [
		{ wave: 'triangle', from: 392, at: 0, length: 0.2 },
		{ wave: 'triangle', from: 370, at: 0.22, length: 0.2 },
		{ wave: 'triangle', from: 349, at: 0.44, length: 0.2 },
		{ wave: 'triangle', from: 330, to: 311, at: 0.66, length: 0.45, vibrato: [6, 6] }
	],
	// soft bell
	'ugly-pray': [
		{ wave: 'sine', from: 1319, at: 0, length: 0.9, decay: true },
		{ wave: 'sine', from: 1976, at: 0, length: 0.6, volume: 0.4, decay: true }
	],
	// cheeky trololo
	trollface: [
		{ wave: 'square', from: 523, at: 0, length: 0.08, volume: 0.35 },
		{ wave: 'square', from: 587, at: 0.09, length: 0.08, volume: 0.35 },
		{ wave: 'square', from: 523, at: 0.18, length: 0.08, volume: 0.35 },
		{ wave: 'square', from: 659, at: 0.27, length: 0.08, volume: 0.35 },
		{ wave: 'square', from: 784, at: 0.36, length: 0.16, volume: 0.35 }
	],
	// low bonk
	janusz: [{ wave: 'sine', from: 190, to: 55, at: 0, length: 0.28, decay: true }]
};

const MASTER_VOLUME = 0.18;

export function playReactionSound(context: AudioContext, id: string): void {
	const notes = SOUNDS[id];
	if (!notes) return;
	const t0 = context.currentTime + 0.01;
	const master = context.createGain();
	master.gain.value = MASTER_VOLUME;
	master.connect(context.destination);
	let end = t0;
	for (const n of notes) {
		const start = t0 + n.at;
		const stop = start + n.length;
		end = Math.max(end, stop);
		const osc = context.createOscillator();
		osc.type = n.wave;
		osc.frequency.setValueAtTime(n.from, start);
		if (n.to) osc.frequency.exponentialRampToValueAtTime(n.to, stop);
		if (n.vibrato) {
			const lfo = context.createOscillator();
			const depth = context.createGain();
			lfo.frequency.value = n.vibrato[1];
			depth.gain.value = n.vibrato[0];
			lfo.connect(depth).connect(osc.frequency);
			lfo.start(start);
			lfo.stop(stop);
		}
		const env = context.createGain();
		const peak = n.volume ?? 1;
		env.gain.setValueAtTime(0.0001, start);
		env.gain.exponentialRampToValueAtTime(peak, start + 0.01);
		if (n.decay) {
			env.gain.exponentialRampToValueAtTime(0.0001, stop);
		} else {
			env.gain.setValueAtTime(peak, Math.max(start + 0.01, stop - 0.03));
			env.gain.exponentialRampToValueAtTime(0.0001, stop);
		}
		osc.connect(env).connect(master);
		osc.start(start);
		osc.stop(stop + 0.02);
	}
	setTimeout(() => master.disconnect(), (end - context.currentTime + 0.2) * 1000);
}
