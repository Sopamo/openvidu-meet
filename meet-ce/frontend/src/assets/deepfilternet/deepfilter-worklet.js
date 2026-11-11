// comeet: AudioWorklet that runs DeepFilterNet3 noise suppression on the microphone (mono, 48 kHz).
// Loaded by DeepFilterNoiseProcessor (audio-track-processor.service.ts). The WASM module is compiled on the main
// thread and passed in with the model bytes; df.js and df_bg.wasm come from scripts/build-deepfilternet.sh.
//
// The audio graph calls process() with blocks of 128 samples, DeepFilterNet works on frames of 480 samples
// (10 ms), so input and output go through ring buffers. This adds one frame of latency on top of the model's own.
import './text-codec-polyfill.js';
import { initSync, df_create, df_get_frame_length, df_process_frame, df_set_atten_lim } from './df.js';

class DeepFilterProcessor extends AudioWorkletProcessor {
	constructor(options) {
		super();
		const { wasmModule, modelBytes, attenLimDb } = options.processorOptions;
		this.state = 0;
		try {
			initSync({ module: wasmModule });
			this.state = df_create(new Uint8Array(modelBytes), attenLimDb);
			this.frame = df_get_frame_length(this.state);
			this.port.postMessage({ type: 'ready', frameLength: this.frame });
		} catch (error) {
			this.port.postMessage({ type: 'error', message: String(error?.message ?? error) });
			return;
		}
		this.size = this.frame * 8;
		this.input = new Float32Array(this.size);
		this.output = new Float32Array(this.size);
		this.inRead = this.inWrite = this.outRead = this.outWrite = 0;
		this.frameIn = new Float32Array(this.frame);
		this.port.onmessage = ({ data }) => {
			if (data?.type === 'attenLimDb' && this.state) df_set_atten_lim(this.state, data.value);
		};
	}

	process(inputs, outputs) {
		const input = inputs[0]?.[0];
		const out = outputs[0];
		if (!input || !out?.length) return true;
		if (!this.state) {
			for (const channel of out) channel.set(input);
			return true;
		}

		const size = this.size;
		for (let i = 0; i < input.length; i++) {
			this.input[this.inWrite] = input[i];
			this.inWrite = (this.inWrite + 1) % size;
		}
		while ((this.inWrite - this.inRead + size) % size >= this.frame) {
			for (let i = 0; i < this.frame; i++) {
				this.frameIn[i] = this.input[this.inRead];
				this.inRead = (this.inRead + 1) % size;
			}
			const enhanced = df_process_frame(this.state, this.frameIn);
			for (let i = 0; i < enhanced.length; i++) {
				this.output[this.outWrite] = enhanced[i];
				this.outWrite = (this.outWrite + 1) % size;
			}
		}

		const block = out[0].length;
		if ((this.outWrite - this.outRead + size) % size >= block) {
			for (let i = 0; i < block; i++) {
				out[0][i] = this.output[this.outRead];
				this.outRead = (this.outRead + 1) % size;
			}
			for (let c = 1; c < out.length; c++) out[c].set(out[0]);
		}
		return true;
	}
}

registerProcessor('comeet-deepfilter', DeepFilterProcessor);
