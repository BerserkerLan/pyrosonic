/**
 * Iterative radix-2 complex FFT (forward transform, no normalisation).
 *
 * X[k] = Σ x[n]·e^(−2πikn/N)
 *
 * Arrays are transformed in place. Tables are precomputed once per size so
 * the transform itself allocates nothing — important because the analyser
 * runs tens of thousands of transforms per song.
 */
export class FFT {
  constructor(size) {
    if (!Number.isInteger(size) || size < 2 || (size & (size - 1)) !== 0) {
      throw new Error(`FFT size must be a power of two, got ${size}`);
    }
    this.size = size;
    const half = size >> 1;
    this.cos = new Float64Array(half);
    this.sin = new Float64Array(half);
    for (let i = 0; i < half; i++) {
      const a = (2 * Math.PI * i) / size;
      this.cos[i] = Math.cos(a);
      this.sin[i] = Math.sin(a);
    }
    const bits = Math.round(Math.log2(size));
    this.rev = new Uint32Array(size);
    for (let i = 0; i < size; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      this.rev[i] = r;
    }
  }

  /** In-place forward FFT of (re, im). */
  transform(re, im) {
    const n = this.size;
    const rev = this.rev;
    const cosT = this.cos;
    const sinT = this.sin;

    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }

    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const step = n / size;
      for (let start = 0; start < n; start += size) {
        let k = 0;
        for (let j = start; j < start + half; j++) {
          const l = j + half;
          const c = cosT[k];
          const s = sinT[k];
          // (re[l] + i·im[l]) · (c − i·s)
          const tre = re[l] * c + im[l] * s;
          const tim = im[l] * c - re[l] * s;
          re[l] = re[j] - tre;
          im[l] = im[j] - tim;
          re[j] += tre;
          im[j] += tim;
          k += step;
        }
      }
    }
  }
}

/**
 * Given the FFT Z of z = a + i·b (a, b real), write the magnitude spectra of
 * a and b (bins 0..N/2) into magA / magB. Lets us transform two real frames
 * with a single complex FFT.
 */
export function splitRealSpectra(re, im, magA, magB, scale) {
  const n = re.length;
  const half = n >> 1;
  for (let k = 0; k <= half; k++) {
    const nk = (n - k) & (n - 1);
    const zr = re[k], zi = im[k];
    const wr = re[nk], wi = im[nk];
    const ar = 0.5 * (zr + wr);
    const ai = 0.5 * (zi - wi);
    const br = 0.5 * (zi + wi);
    const bi = 0.5 * (wr - zr);
    magA[k] = Math.sqrt(ar * ar + ai * ai) * scale;
    magB[k] = Math.sqrt(br * br + bi * bi) * scale;
  }
}
