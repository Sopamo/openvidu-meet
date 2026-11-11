// comeet: AudioWorkletGlobalScope has no TextDecoder/TextEncoder, but the wasm-bindgen glue (df.js) creates a
// TextDecoder when it is evaluated. It only decodes strings for panic/error messages, so a small UTF-8 decoder is
// enough. Imported by deepfilter-worklet.js before df.js (ES modules are evaluated in import order).
if (typeof globalThis.TextDecoder === 'undefined') {
	globalThis.TextDecoder = class {
		decode(input) {
			if (!input) return '';
			const bytes = input instanceof Uint8Array ? input : new Uint8Array(input.buffer ?? input);
			let out = '';
			for (let i = 0; i < bytes.length; ) {
				const b = bytes[i++];
				let cp;
				if (b < 0x80) cp = b;
				else if (b < 0xe0) cp = ((b & 0x1f) << 6) | (bytes[i++] & 0x3f);
				else if (b < 0xf0) cp = ((b & 0x0f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f);
				else
					cp =
						((b & 0x07) << 18) |
						((bytes[i++] & 0x3f) << 12) |
						((bytes[i++] & 0x3f) << 6) |
						(bytes[i++] & 0x3f);
				out += String.fromCodePoint(cp);
			}
			return out;
		}
	};
}
if (typeof globalThis.TextEncoder === 'undefined') {
	globalThis.TextEncoder = class {
		encode(str = '') {
			const out = [];
			for (const ch of str) {
				const cp = ch.codePointAt(0);
				if (cp < 0x80) out.push(cp);
				else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
				else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
				else
					out.push(
						0xf0 | (cp >> 18),
						0x80 | ((cp >> 12) & 0x3f),
						0x80 | ((cp >> 6) & 0x3f),
						0x80 | (cp & 0x3f)
					);
			}
			return new Uint8Array(out);
		}
		encodeInto(str, dest) {
			const bytes = this.encode(str);
			const n = Math.min(bytes.length, dest.length);
			dest.set(bytes.subarray(0, n));
			return { read: str.length, written: n };
		}
	};
}
