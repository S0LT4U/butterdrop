'use strict';

// TV Mode capture tap: decimates and packs audio on the audio rendering
// thread. A ScriptProcessor tap on the main thread misses callbacks while
// the visualizer renders heavy presets, punching real gaps into the stream
// sent to TVs — this thread can't be starved by rendering.
class ButterdropTap extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.factor = (options.processorOptions && options.processorOptions.factor) || 1;
    this.chunkFrames = 2048; // ~43ms per message at 48 kHz
    this.out = new Int16Array(this.chunkFrames * 2);
    this.filled = 0;
    this.accL = 0;
    this.accR = 0;
    this.accN = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;
    const L = input[0];
    const R = input[1] || L;
    for (let i = 0; i < L.length; i++) {
      this.accL += L[i];
      this.accR += R[i];
      if (++this.accN === this.factor) {
        let l = this.accL / this.factor;
        let r = this.accR / this.factor;
        l = l > 1 ? 1 : l < -1 ? -1 : l;
        r = r > 1 ? 1 : r < -1 ? -1 : r;
        this.out[this.filled * 2] = l * 0x7fff;
        this.out[this.filled * 2 + 1] = r * 0x7fff;
        this.accL = 0;
        this.accR = 0;
        this.accN = 0;
        if (++this.filled === this.chunkFrames) {
          this.port.postMessage(this.out.buffer, [this.out.buffer]);
          this.out = new Int16Array(this.chunkFrames * 2);
          this.filled = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor('butterdrop-tap', ButterdropTap);
