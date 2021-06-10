/*!
 * pulsejet-ts v0.0.1
 * 
 *
 * Copyright (c) 2021 FMS_Cat
 * pulsejet-ts is distributed under MIT License
 * https://github.com/FMS-Cat/pulsejet-ts/blob/master/LICENSE
 */
(function (global, factory) {
    typeof exports === 'object' && typeof module !== 'undefined' ? factory(exports) :
    typeof define === 'function' && define.amd ? define(['exports'], factory) :
    (global = typeof globalThis !== 'undefined' ? globalThis : global || self, factory(global.PULSEJET = {}));
}(this, (function (exports) { 'use strict';

    const sampleTag = 'PLSJ';
    const codecVersionMajor = 0;
    const codecVersionMinor = 1;
    const frameSize = 1024;
    const numShortWindowsPerFrame = 8;
    const longWindowSize = frameSize * 2;
    const shortWindowSize = longWindowSize / numShortWindowsPerFrame;
    const numBands = 20;
    const numTotalBins = 856;
    exports.WindowMode = void 0;
    (function (WindowMode) {
        WindowMode[WindowMode["Long"] = 0] = "Long";
        WindowMode[WindowMode["Short"] = 1] = "Short";
        WindowMode[WindowMode["Start"] = 2] = "Start";
        WindowMode[WindowMode["Stop"] = 3] = "Stop";
    })(exports.WindowMode || (exports.WindowMode = {}));
    const bandToNumBins = [
        8, 8, 8, 8, 8, 8, 8, 8, 16, 16, 24, 32, 32, 40, 48, 64, 80, 120, 144, 176,
    ];
    function vorbisWindow(nPlusHalf, size) {
        const sineWindow = Math.sin(Math.PI / size * nPlusHalf);
        return Math.sin(Math.PI / 2.0 * sineWindow * sineWindow);
    }
    function mdctWindow(n, size, mode) {
        const nPlusHalf = n + 0.5;
        if (mode === exports.WindowMode.Start) {
            const shortWindowOffset = longWindowSize * 3 / 4 - shortWindowSize / 4;
            if (n >= shortWindowOffset + shortWindowSize / 2) {
                return 0.0;
            }
            else if (n >= shortWindowOffset) {
                return 1.0 - vorbisWindow(nPlusHalf - shortWindowOffset, shortWindowSize);
            }
            else if (n >= longWindowSize / 2) {
                return 1.0;
            }
        }
        else if (mode === exports.WindowMode.Stop) {
            const shortWindowOffset = longWindowSize / 4 - shortWindowSize / 4;
            if (n < shortWindowOffset) {
                return 0.0;
            }
            else if (n < shortWindowOffset + shortWindowSize / 2) {
                return vorbisWindow(nPlusHalf - shortWindowOffset, shortWindowSize);
            }
            else if (n < longWindowSize / 2) {
                return 1.0;
            }
        }
        return vorbisWindow(nPlusHalf, size);
    }

    /**
     * Decodes an encoded pulsejet sample into a newly-allocated buffer.
     *
     * This function is optimized for size and designed to be compiled in a
     * size-constrained environment. In such environments, it's common not
     * to have access to all of the required math functions, and instead
     * implement them by hand. For this reason, this decoder does not
     * depend on any such functions directly, and instead expects that
     * `CosF`, `Exp2F`, `SinF`, and `SqrtF` functions are defined in the
     * `Pulsejet::Shims` namespace before including relevant pulsejet
     * header(s). pulsejet expects that these functions behave similarly
     * to the corresponding similarly-named cmath functions. This shim
     * mechanism can also be used to provide less accurate, speed-optimized
     * versions of these functions if desired.
     *
     * Additionally, this function will not perform any error checking or
     * handling. The included metadata API can be used for high-level error
     * checking before decoding takes place if required (albeit not in a
     * non-size-constrained environment).
     *
     * @param input Encoded pulsejet byte stream.
     * @return Decoded samples in the [-1, 1] range (normalized).
     *         This buffer is allocated by `new []` and should be freed
     *         using `delete []`.
     */
    function decode(input) {
        const inputView = new DataView(input.buffer, input.byteOffset, input.byteLength);
        let inputViewPtr = 0;
        // Skip tag and codec version
        inputViewPtr += 8;
        // Read frame count, determine number of samples, and allocate output sample buffer
        let numFrames = inputView.getUint16(inputViewPtr, true);
        inputViewPtr += 2; // sizeof u16
        const numSamples = numFrames * frameSize;
        const samples = new Float32Array(numSamples);
        // We're going to decode one more frame than we output, so adjust the frame count
        numFrames++;
        // Set up and skip window mode stream
        let windowModePtr = inputViewPtr;
        inputViewPtr += numFrames;
        // Set up and skip quantized band bin stream
        let quantizedBandBinPtr = inputViewPtr;
        inputViewPtr += numFrames * numTotalBins;
        // Allocate padded sample buffer, and fill with silence
        const numPaddedSamples = numSamples + frameSize * 2;
        const paddedSamples = new Float32Array(numPaddedSamples);
        // Clear quantized band energy predictions
        const quantizedBandEnergyPredictions = new Uint8Array(numBands);
        // Decode frames
        for (let frameIndex = 0; frameIndex < numFrames; frameIndex++) {
            // Read window mode for this frame
            const windowMode = input[windowModePtr++];
            // Determine subframe configuration from window mode
            let numSubframes = 1;
            let subframeWindowOffset = 0;
            let subframeWindowSize = longWindowSize;
            if (windowMode === exports.WindowMode.Short) {
                numSubframes = numShortWindowsPerFrame;
                subframeWindowOffset = longWindowSize / 4 - shortWindowSize / 4;
                subframeWindowSize = shortWindowSize;
            }
            // Decode subframe(s)
            for (let subframeIndex = 0; subframeIndex < numSubframes; subframeIndex++) {
                // Decode bands
                const windowBins = new Float32Array(frameSize);
                let bandBinsPtr = 0;
                for (let bandIndex = 0; bandIndex < numBands; bandIndex++) {
                    // Decode band bins
                    const numBins = bandToNumBins[bandIndex] / numSubframes;
                    let numNonzeroBins = 0;
                    for (let binIndex = 0; binIndex < numBins; binIndex++) {
                        const binQ = inputView.getInt8(quantizedBandBinPtr++);
                        if (binQ) {
                            numNonzeroBins++;
                        }
                        const bin = binQ;
                        windowBins[bandBinsPtr + binIndex] = bin;
                    }
                    // If this band is significantly sparse, fill in (nearly) spectrally flat noise
                    const binFill = numNonzeroBins / numBins;
                    const noiseFillThreshold = 0.1;
                    if (binFill < noiseFillThreshold) {
                        const binSparsity = (noiseFillThreshold - binFill) / noiseFillThreshold;
                        const noiseFillGain = binSparsity * binSparsity;
                        for (let binIndex = 0; binIndex < numBins; binIndex++) {
                            // Use the Math.random() instead of lcg
                            const noiseSample = Math.random() * 2.0 - 1.0;
                            windowBins[bandBinsPtr + binIndex] += noiseSample * noiseFillGain;
                        }
                    }
                    // Decode band energy
                    const quantizedBandEnergyResidual = input[inputViewPtr++];
                    const quantizedBandEnergy = (quantizedBandEnergyPredictions[bandIndex] + quantizedBandEnergyResidual) & 255;
                    quantizedBandEnergyPredictions[bandIndex] = quantizedBandEnergy;
                    const bandEnergy = Math.pow(2.0, quantizedBandEnergy / 64.0 * 40.0 - 20.0) * numBins;
                    // Normalize band bins and scale by band energy
                    const epsilon = 1e-27;
                    let bandBinEnergy = epsilon;
                    for (let binIndex = 0; binIndex < numBins; binIndex++) {
                        const bin = windowBins[bandBinsPtr + binIndex];
                        bandBinEnergy += bin * bin;
                    }
                    bandBinEnergy = Math.sqrt(bandBinEnergy);
                    const binScale = bandEnergy / bandBinEnergy;
                    for (let binIndex = 0; binIndex < numBins; binIndex++) {
                        windowBins[bandBinsPtr + binIndex] *= binScale;
                    }
                    bandBinsPtr += numBins;
                }
                // Apply the IMDCT to the subframe bins, then apply the appropriate window to the resulting samples, and finally accumulate them into the padded output buffer
                const frameOffset = frameIndex * frameSize;
                const windowOffset = subframeWindowOffset + subframeIndex * subframeWindowSize / 2;
                for (let n = 0; n < subframeWindowSize; n++) {
                    const nPlusHalf = n + 0.5;
                    let sample = 0.0;
                    for (let k = 0; k < (subframeWindowSize >> 1); k++) {
                        if (windowBins[k]) {
                            sample += (2.0 / (subframeWindowSize >> 1)) * windowBins[k] * Math.cos(Math.PI / (subframeWindowSize >> 1) * (nPlusHalf + (subframeWindowSize >> 2)) * (k + 0.5));
                        }
                    }
                    const window = mdctWindow(n, subframeWindowSize, windowMode);
                    paddedSamples[frameOffset + windowOffset + n] += sample * window;
                }
            }
        }
        // Copy samples without padding to the output buffer
        samples.set(new Float32Array(paddedSamples.buffer, frameSize, numSamples));
        // Free padded sample buffer
        // delete [] paddedSamples;
        return samples;
    }

    exports.bandToNumBins = bandToNumBins;
    exports.codecVersionMajor = codecVersionMajor;
    exports.codecVersionMinor = codecVersionMinor;
    exports.decode = decode;
    exports.frameSize = frameSize;
    exports.longWindowSize = longWindowSize;
    exports.mdctWindow = mdctWindow;
    exports.numBands = numBands;
    exports.numShortWindowsPerFrame = numShortWindowsPerFrame;
    exports.numTotalBins = numTotalBins;
    exports.sampleTag = sampleTag;
    exports.shortWindowSize = shortWindowSize;
    exports.vorbisWindow = vorbisWindow;

    Object.defineProperty(exports, '__esModule', { value: true });

})));
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicHVsc2VqZXQuanMiLCJzb3VyY2VzIjpbIi4uL3NyYy9jb21tb24udHMiLCIuLi9zcmMvZGVjb2RlLnRzIl0sInNvdXJjZXNDb250ZW50IjpbImV4cG9ydCBjb25zdCBzYW1wbGVUYWcgPSAnUExTSic7XG5cbmV4cG9ydCBjb25zdCBjb2RlY1ZlcnNpb25NYWpvciA9IDA7XG5leHBvcnQgY29uc3QgY29kZWNWZXJzaW9uTWlub3IgPSAxO1xuXG5leHBvcnQgY29uc3QgZnJhbWVTaXplID0gMTAyNDtcbmV4cG9ydCBjb25zdCBudW1TaG9ydFdpbmRvd3NQZXJGcmFtZSA9IDg7XG5leHBvcnQgY29uc3QgbG9uZ1dpbmRvd1NpemUgPSBmcmFtZVNpemUgKiAyO1xuZXhwb3J0IGNvbnN0IHNob3J0V2luZG93U2l6ZSA9IGxvbmdXaW5kb3dTaXplIC8gbnVtU2hvcnRXaW5kb3dzUGVyRnJhbWU7XG5cbmV4cG9ydCBjb25zdCBudW1CYW5kcyA9IDIwO1xuZXhwb3J0IGNvbnN0IG51bVRvdGFsQmlucyA9IDg1NjtcblxuZXhwb3J0IGVudW0gV2luZG93TW9kZSB7XG4gIExvbmcgPSAwLFxuICBTaG9ydCA9IDEsXG4gIFN0YXJ0ID0gMixcbiAgU3RvcCA9IDMsXG59O1xuXG5leHBvcnQgY29uc3QgYmFuZFRvTnVtQmlucyA9IFtcbiAgOCwgOCwgOCwgOCwgOCwgOCwgOCwgOCwgMTYsIDE2LCAyNCwgMzIsIDMyLCA0MCwgNDgsIDY0LCA4MCwgMTIwLCAxNDQsIDE3Nixcbl07XG5cbmV4cG9ydCBmdW5jdGlvbiB2b3JiaXNXaW5kb3coIG5QbHVzSGFsZjogbnVtYmVyLCBzaXplOiBudW1iZXIgKTogbnVtYmVyIHtcbiAgY29uc3Qgc2luZVdpbmRvdyA9IE1hdGguc2luKCBNYXRoLlBJIC8gc2l6ZSAqIG5QbHVzSGFsZiApO1xuICByZXR1cm4gTWF0aC5zaW4oIE1hdGguUEkgLyAyLjAgKiBzaW5lV2luZG93ICogc2luZVdpbmRvdyApO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gbWRjdFdpbmRvdyggbjogbnVtYmVyLCBzaXplOiBudW1iZXIsIG1vZGU6IFdpbmRvd01vZGUgKTogbnVtYmVyIHtcbiAgY29uc3QgblBsdXNIYWxmID0gbiArIDAuNTtcblxuICBpZiAoIG1vZGUgPT09IFdpbmRvd01vZGUuU3RhcnQgKSB7XG4gICAgY29uc3Qgc2hvcnRXaW5kb3dPZmZzZXQgPSBsb25nV2luZG93U2l6ZSAqIDMgLyA0IC0gc2hvcnRXaW5kb3dTaXplIC8gNDtcbiAgICBpZiAoIG4gPj0gc2hvcnRXaW5kb3dPZmZzZXQgKyBzaG9ydFdpbmRvd1NpemUgLyAyICkge1xuICAgICAgcmV0dXJuIDAuMDtcbiAgICB9IGVsc2UgaWYgKCBuID49IHNob3J0V2luZG93T2Zmc2V0ICkge1xuICAgICAgcmV0dXJuIDEuMCAtIHZvcmJpc1dpbmRvdyggblBsdXNIYWxmIC0gc2hvcnRXaW5kb3dPZmZzZXQsIHNob3J0V2luZG93U2l6ZSApO1xuICAgIH0gZWxzZSBpZiAoIG4gPj0gbG9uZ1dpbmRvd1NpemUgLyAyICkge1xuICAgICAgcmV0dXJuIDEuMDtcbiAgICB9XG4gIH0gZWxzZSBpZiAoIG1vZGUgPT09IFdpbmRvd01vZGUuU3RvcCApIHtcbiAgICBjb25zdCBzaG9ydFdpbmRvd09mZnNldCA9IGxvbmdXaW5kb3dTaXplIC8gNCAtIHNob3J0V2luZG93U2l6ZSAvIDQ7XG4gICAgaWYgKCBuIDwgc2hvcnRXaW5kb3dPZmZzZXQgKSB7XG4gICAgICByZXR1cm4gMC4wO1xuICAgIH0gZWxzZSBpZiAoIG4gPCBzaG9ydFdpbmRvd09mZnNldCArIHNob3J0V2luZG93U2l6ZSAvIDIgKSB7XG4gICAgICByZXR1cm4gdm9yYmlzV2luZG93KCBuUGx1c0hhbGYgLSBzaG9ydFdpbmRvd09mZnNldCwgc2hvcnRXaW5kb3dTaXplICk7XG4gICAgfSBlbHNlIGlmICggbiA8IGxvbmdXaW5kb3dTaXplIC8gMiApIHtcbiAgICAgIHJldHVybiAxLjA7XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIHZvcmJpc1dpbmRvdyggblBsdXNIYWxmLCBzaXplICk7XG59XG4iLCJpbXBvcnQgeyBiYW5kVG9OdW1CaW5zLCBmcmFtZVNpemUsIGxvbmdXaW5kb3dTaXplLCBtZGN0V2luZG93LCBudW1CYW5kcywgbnVtU2hvcnRXaW5kb3dzUGVyRnJhbWUsIG51bVRvdGFsQmlucywgc2hvcnRXaW5kb3dTaXplLCBXaW5kb3dNb2RlIH0gZnJvbSAnLi9jb21tb24nO1xuXG4vKipcbiAqIERlY29kZXMgYW4gZW5jb2RlZCBwdWxzZWpldCBzYW1wbGUgaW50byBhIG5ld2x5LWFsbG9jYXRlZCBidWZmZXIuXG4gKlxuICogVGhpcyBmdW5jdGlvbiBpcyBvcHRpbWl6ZWQgZm9yIHNpemUgYW5kIGRlc2lnbmVkIHRvIGJlIGNvbXBpbGVkIGluIGFcbiAqIHNpemUtY29uc3RyYWluZWQgZW52aXJvbm1lbnQuIEluIHN1Y2ggZW52aXJvbm1lbnRzLCBpdCdzIGNvbW1vbiBub3RcbiAqIHRvIGhhdmUgYWNjZXNzIHRvIGFsbCBvZiB0aGUgcmVxdWlyZWQgbWF0aCBmdW5jdGlvbnMsIGFuZCBpbnN0ZWFkXG4gKiBpbXBsZW1lbnQgdGhlbSBieSBoYW5kLiBGb3IgdGhpcyByZWFzb24sIHRoaXMgZGVjb2RlciBkb2VzIG5vdFxuICogZGVwZW5kIG9uIGFueSBzdWNoIGZ1bmN0aW9ucyBkaXJlY3RseSwgYW5kIGluc3RlYWQgZXhwZWN0cyB0aGF0XG4gKiBgQ29zRmAsIGBFeHAyRmAsIGBTaW5GYCwgYW5kIGBTcXJ0RmAgZnVuY3Rpb25zIGFyZSBkZWZpbmVkIGluIHRoZVxuICogYFB1bHNlamV0OjpTaGltc2AgbmFtZXNwYWNlIGJlZm9yZSBpbmNsdWRpbmcgcmVsZXZhbnQgcHVsc2VqZXRcbiAqIGhlYWRlcihzKS4gcHVsc2VqZXQgZXhwZWN0cyB0aGF0IHRoZXNlIGZ1bmN0aW9ucyBiZWhhdmUgc2ltaWxhcmx5XG4gKiB0byB0aGUgY29ycmVzcG9uZGluZyBzaW1pbGFybHktbmFtZWQgY21hdGggZnVuY3Rpb25zLiBUaGlzIHNoaW1cbiAqIG1lY2hhbmlzbSBjYW4gYWxzbyBiZSB1c2VkIHRvIHByb3ZpZGUgbGVzcyBhY2N1cmF0ZSwgc3BlZWQtb3B0aW1pemVkXG4gKiB2ZXJzaW9ucyBvZiB0aGVzZSBmdW5jdGlvbnMgaWYgZGVzaXJlZC5cbiAqXG4gKiBBZGRpdGlvbmFsbHksIHRoaXMgZnVuY3Rpb24gd2lsbCBub3QgcGVyZm9ybSBhbnkgZXJyb3IgY2hlY2tpbmcgb3JcbiAqIGhhbmRsaW5nLiBUaGUgaW5jbHVkZWQgbWV0YWRhdGEgQVBJIGNhbiBiZSB1c2VkIGZvciBoaWdoLWxldmVsIGVycm9yXG4gKiBjaGVja2luZyBiZWZvcmUgZGVjb2RpbmcgdGFrZXMgcGxhY2UgaWYgcmVxdWlyZWQgKGFsYmVpdCBub3QgaW4gYVxuICogbm9uLXNpemUtY29uc3RyYWluZWQgZW52aXJvbm1lbnQpLlxuICpcbiAqIEBwYXJhbSBpbnB1dCBFbmNvZGVkIHB1bHNlamV0IGJ5dGUgc3RyZWFtLlxuICogQHJldHVybiBEZWNvZGVkIHNhbXBsZXMgaW4gdGhlIFstMSwgMV0gcmFuZ2UgKG5vcm1hbGl6ZWQpLlxuICogICAgICAgICBUaGlzIGJ1ZmZlciBpcyBhbGxvY2F0ZWQgYnkgYG5ldyBbXWAgYW5kIHNob3VsZCBiZSBmcmVlZFxuICogICAgICAgICB1c2luZyBgZGVsZXRlIFtdYC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGRlY29kZSggaW5wdXQ6IFVpbnQ4QXJyYXkgKTogRmxvYXQzMkFycmF5IHtcbiAgY29uc3QgaW5wdXRWaWV3ID0gbmV3IERhdGFWaWV3KCBpbnB1dC5idWZmZXIsIGlucHV0LmJ5dGVPZmZzZXQsIGlucHV0LmJ5dGVMZW5ndGggKTtcbiAgbGV0IGlucHV0Vmlld1B0ciA9IDA7XG5cbiAgLy8gU2tpcCB0YWcgYW5kIGNvZGVjIHZlcnNpb25cbiAgaW5wdXRWaWV3UHRyICs9IDg7XG5cbiAgLy8gUmVhZCBmcmFtZSBjb3VudCwgZGV0ZXJtaW5lIG51bWJlciBvZiBzYW1wbGVzLCBhbmQgYWxsb2NhdGUgb3V0cHV0IHNhbXBsZSBidWZmZXJcbiAgbGV0IG51bUZyYW1lcyA9IGlucHV0Vmlldy5nZXRVaW50MTYoIGlucHV0Vmlld1B0ciwgdHJ1ZSApO1xuICBpbnB1dFZpZXdQdHIgKz0gMjsgLy8gc2l6ZW9mIHUxNlxuICBjb25zdCBudW1TYW1wbGVzID0gbnVtRnJhbWVzICogZnJhbWVTaXplO1xuICBjb25zdCBzYW1wbGVzID0gbmV3IEZsb2F0MzJBcnJheSggbnVtU2FtcGxlcyApO1xuXG4gIC8vIFdlJ3JlIGdvaW5nIHRvIGRlY29kZSBvbmUgbW9yZSBmcmFtZSB0aGFuIHdlIG91dHB1dCwgc28gYWRqdXN0IHRoZSBmcmFtZSBjb3VudFxuICBudW1GcmFtZXMgKys7XG5cbiAgLy8gU2V0IHVwIGFuZCBza2lwIHdpbmRvdyBtb2RlIHN0cmVhbVxuICBsZXQgd2luZG93TW9kZVB0ciA9IGlucHV0Vmlld1B0cjtcbiAgaW5wdXRWaWV3UHRyICs9IG51bUZyYW1lcztcblxuICAvLyBTZXQgdXAgYW5kIHNraXAgcXVhbnRpemVkIGJhbmQgYmluIHN0cmVhbVxuICBsZXQgcXVhbnRpemVkQmFuZEJpblB0ciA9IGlucHV0Vmlld1B0cjtcbiAgaW5wdXRWaWV3UHRyICs9IG51bUZyYW1lcyAqIG51bVRvdGFsQmlucztcblxuICAvLyBBbGxvY2F0ZSBwYWRkZWQgc2FtcGxlIGJ1ZmZlciwgYW5kIGZpbGwgd2l0aCBzaWxlbmNlXG4gIGNvbnN0IG51bVBhZGRlZFNhbXBsZXMgPSBudW1TYW1wbGVzICsgZnJhbWVTaXplICogMjtcbiAgY29uc3QgcGFkZGVkU2FtcGxlcyA9IG5ldyBGbG9hdDMyQXJyYXkoIG51bVBhZGRlZFNhbXBsZXMgKTtcblxuICAvLyBDbGVhciBxdWFudGl6ZWQgYmFuZCBlbmVyZ3kgcHJlZGljdGlvbnNcbiAgY29uc3QgcXVhbnRpemVkQmFuZEVuZXJneVByZWRpY3Rpb25zID0gbmV3IFVpbnQ4QXJyYXkoIG51bUJhbmRzICk7XG5cbiAgLy8gRGVjb2RlIGZyYW1lc1xuICBmb3IgKCBsZXQgZnJhbWVJbmRleCA9IDA7IGZyYW1lSW5kZXggPCBudW1GcmFtZXM7IGZyYW1lSW5kZXggKysgKSB7XG4gICAgLy8gUmVhZCB3aW5kb3cgbW9kZSBmb3IgdGhpcyBmcmFtZVxuICAgIGNvbnN0IHdpbmRvd01vZGU6IFdpbmRvd01vZGUgPSBpbnB1dFsgd2luZG93TW9kZVB0ciArKyBdO1xuXG4gICAgLy8gRGV0ZXJtaW5lIHN1YmZyYW1lIGNvbmZpZ3VyYXRpb24gZnJvbSB3aW5kb3cgbW9kZVxuICAgIGxldCBudW1TdWJmcmFtZXMgPSAxO1xuICAgIGxldCBzdWJmcmFtZVdpbmRvd09mZnNldCA9IDA7XG4gICAgbGV0IHN1YmZyYW1lV2luZG93U2l6ZSA9IGxvbmdXaW5kb3dTaXplO1xuICAgIGlmICggd2luZG93TW9kZSA9PT0gV2luZG93TW9kZS5TaG9ydCApIHtcbiAgICAgIG51bVN1YmZyYW1lcyA9IG51bVNob3J0V2luZG93c1BlckZyYW1lO1xuICAgICAgc3ViZnJhbWVXaW5kb3dPZmZzZXQgPSBsb25nV2luZG93U2l6ZSAvIDQgLSBzaG9ydFdpbmRvd1NpemUgLyA0O1xuICAgICAgc3ViZnJhbWVXaW5kb3dTaXplID0gc2hvcnRXaW5kb3dTaXplO1xuICAgIH1cblxuICAgIC8vIERlY29kZSBzdWJmcmFtZShzKVxuICAgIGZvciAoIGxldCBzdWJmcmFtZUluZGV4ID0gMDsgc3ViZnJhbWVJbmRleCA8IG51bVN1YmZyYW1lczsgc3ViZnJhbWVJbmRleCArKyApIHtcbiAgICAgIC8vIERlY29kZSBiYW5kc1xuICAgICAgY29uc3Qgd2luZG93QmlucyA9IG5ldyBGbG9hdDMyQXJyYXkoIGZyYW1lU2l6ZSApO1xuICAgICAgbGV0IGJhbmRCaW5zUHRyID0gMDtcbiAgICAgIGZvciAoIGxldCBiYW5kSW5kZXggPSAwOyBiYW5kSW5kZXggPCBudW1CYW5kczsgYmFuZEluZGV4ICsrICkge1xuICAgICAgICAvLyBEZWNvZGUgYmFuZCBiaW5zXG4gICAgICAgIGNvbnN0IG51bUJpbnMgPSBiYW5kVG9OdW1CaW5zWyBiYW5kSW5kZXggXSAvIG51bVN1YmZyYW1lcztcbiAgICAgICAgbGV0IG51bU5vbnplcm9CaW5zID0gMDtcbiAgICAgICAgZm9yICggbGV0IGJpbkluZGV4ID0gMDsgYmluSW5kZXggPCBudW1CaW5zOyBiaW5JbmRleCArKyApIHtcbiAgICAgICAgICBjb25zdCBiaW5RID0gaW5wdXRWaWV3LmdldEludDgoIHF1YW50aXplZEJhbmRCaW5QdHIgKysgKTtcbiAgICAgICAgICBpZiAoIGJpblEgKSB7XG4gICAgICAgICAgICBudW1Ob256ZXJvQmlucyArKztcbiAgICAgICAgICB9XG4gICAgICAgICAgY29uc3QgYmluID0gYmluUTtcbiAgICAgICAgICB3aW5kb3dCaW5zWyBiYW5kQmluc1B0ciArIGJpbkluZGV4IF0gPSBiaW47XG4gICAgICAgIH1cblxuICAgICAgICAvLyBJZiB0aGlzIGJhbmQgaXMgc2lnbmlmaWNhbnRseSBzcGFyc2UsIGZpbGwgaW4gKG5lYXJseSkgc3BlY3RyYWxseSBmbGF0IG5vaXNlXG4gICAgICAgIGNvbnN0IGJpbkZpbGwgPSBudW1Ob256ZXJvQmlucyAvIG51bUJpbnM7XG4gICAgICAgIGNvbnN0IG5vaXNlRmlsbFRocmVzaG9sZCA9IDAuMTtcbiAgICAgICAgaWYgKCBiaW5GaWxsIDwgbm9pc2VGaWxsVGhyZXNob2xkICkge1xuICAgICAgICAgIGNvbnN0IGJpblNwYXJzaXR5ID0gKG5vaXNlRmlsbFRocmVzaG9sZCAtIGJpbkZpbGwpIC8gbm9pc2VGaWxsVGhyZXNob2xkO1xuICAgICAgICAgIGNvbnN0IG5vaXNlRmlsbEdhaW4gPSBiaW5TcGFyc2l0eSAqIGJpblNwYXJzaXR5O1xuICAgICAgICAgIGZvciAoIGxldCBiaW5JbmRleCA9IDA7IGJpbkluZGV4IDwgbnVtQmluczsgYmluSW5kZXggKysgKSB7XG4gICAgICAgICAgICAvLyBVc2UgdGhlIE1hdGgucmFuZG9tKCkgaW5zdGVhZCBvZiBsY2dcbiAgICAgICAgICAgIGNvbnN0IG5vaXNlU2FtcGxlID0gTWF0aC5yYW5kb20oKSAqIDIuMCAtIDEuMDtcbiAgICAgICAgICAgIHdpbmRvd0JpbnNbIGJhbmRCaW5zUHRyICsgYmluSW5kZXggXSArPSBub2lzZVNhbXBsZSAqIG5vaXNlRmlsbEdhaW47XG4gICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgLy8gRGVjb2RlIGJhbmQgZW5lcmd5XG4gICAgICAgIGNvbnN0IHF1YW50aXplZEJhbmRFbmVyZ3lSZXNpZHVhbCA9IGlucHV0WyBpbnB1dFZpZXdQdHIgKysgXTtcbiAgICAgICAgY29uc3QgcXVhbnRpemVkQmFuZEVuZXJneSA9ICggcXVhbnRpemVkQmFuZEVuZXJneVByZWRpY3Rpb25zWyBiYW5kSW5kZXggXSArIHF1YW50aXplZEJhbmRFbmVyZ3lSZXNpZHVhbCApICYgMjU1O1xuICAgICAgICBxdWFudGl6ZWRCYW5kRW5lcmd5UHJlZGljdGlvbnNbIGJhbmRJbmRleCBdID0gcXVhbnRpemVkQmFuZEVuZXJneTtcbiAgICAgICAgY29uc3QgYmFuZEVuZXJneSA9IE1hdGgucG93KCAyLjAsIHF1YW50aXplZEJhbmRFbmVyZ3kgLyA2NC4wICogNDAuMCAtIDIwLjAgKSAqIG51bUJpbnM7XG5cbiAgICAgICAgLy8gTm9ybWFsaXplIGJhbmQgYmlucyBhbmQgc2NhbGUgYnkgYmFuZCBlbmVyZ3lcbiAgICAgICAgY29uc3QgZXBzaWxvbiA9IDFlLTI3O1xuICAgICAgICBsZXQgYmFuZEJpbkVuZXJneSA9IGVwc2lsb247XG4gICAgICAgIGZvciAoIGxldCBiaW5JbmRleCA9IDA7IGJpbkluZGV4IDwgbnVtQmluczsgYmluSW5kZXggKysgKSB7XG4gICAgICAgICAgY29uc3QgYmluID0gd2luZG93Qmluc1sgYmFuZEJpbnNQdHIgKyBiaW5JbmRleCBdO1xuICAgICAgICAgIGJhbmRCaW5FbmVyZ3kgKz0gYmluICogYmluO1xuICAgICAgICB9XG4gICAgICAgIGJhbmRCaW5FbmVyZ3kgPSBNYXRoLnNxcnQoIGJhbmRCaW5FbmVyZ3kgKTtcbiAgICAgICAgY29uc3QgYmluU2NhbGUgPSBiYW5kRW5lcmd5IC8gYmFuZEJpbkVuZXJneTtcbiAgICAgICAgZm9yICggbGV0IGJpbkluZGV4ID0gMDsgYmluSW5kZXggPCBudW1CaW5zOyBiaW5JbmRleCArKyApIHtcbiAgICAgICAgICB3aW5kb3dCaW5zWyBiYW5kQmluc1B0ciArIGJpbkluZGV4IF0gKj0gYmluU2NhbGU7XG4gICAgICAgIH1cblxuICAgICAgICBiYW5kQmluc1B0ciArPSBudW1CaW5zO1xuICAgICAgfVxuXG4gICAgICAvLyBBcHBseSB0aGUgSU1EQ1QgdG8gdGhlIHN1YmZyYW1lIGJpbnMsIHRoZW4gYXBwbHkgdGhlIGFwcHJvcHJpYXRlIHdpbmRvdyB0byB0aGUgcmVzdWx0aW5nIHNhbXBsZXMsIGFuZCBmaW5hbGx5IGFjY3VtdWxhdGUgdGhlbSBpbnRvIHRoZSBwYWRkZWQgb3V0cHV0IGJ1ZmZlclxuICAgICAgY29uc3QgZnJhbWVPZmZzZXQgPSBmcmFtZUluZGV4ICogZnJhbWVTaXplO1xuICAgICAgY29uc3Qgd2luZG93T2Zmc2V0ID0gc3ViZnJhbWVXaW5kb3dPZmZzZXQgKyBzdWJmcmFtZUluZGV4ICogc3ViZnJhbWVXaW5kb3dTaXplIC8gMjtcbiAgICAgIGZvciAoIGxldCBuID0gMDsgbiA8IHN1YmZyYW1lV2luZG93U2l6ZTsgbiArKyApIHtcbiAgICAgICAgY29uc3QgblBsdXNIYWxmID0gbiArIDAuNTtcblxuICAgICAgICBsZXQgc2FtcGxlID0gMC4wO1xuICAgICAgICBmb3IgKCBsZXQgayA9IDA7IGsgPCAoIHN1YmZyYW1lV2luZG93U2l6ZSA+PiAxICk7IGsgKysgKSB7XG4gICAgICAgICAgaWYgKCB3aW5kb3dCaW5zWyBrIF0gKSB7XG4gICAgICAgICAgICBzYW1wbGUgKz0gKCAyLjAgLyAoIHN1YmZyYW1lV2luZG93U2l6ZSA+PiAxICkgKSAqIHdpbmRvd0JpbnNbIGsgXSAqIE1hdGguY29zKCBNYXRoLlBJIC8gKCBzdWJmcmFtZVdpbmRvd1NpemUgPj4gMSApICogKCBuUGx1c0hhbGYgKyAoIHN1YmZyYW1lV2luZG93U2l6ZSA+PiAyICkgKSAqICggayArIDAuNSApICk7XG4gICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgY29uc3Qgd2luZG93ID0gbWRjdFdpbmRvdyggbiwgc3ViZnJhbWVXaW5kb3dTaXplLCB3aW5kb3dNb2RlICk7XG4gICAgICAgIHBhZGRlZFNhbXBsZXNbIGZyYW1lT2Zmc2V0ICsgd2luZG93T2Zmc2V0ICsgbiBdICs9IHNhbXBsZSAqIHdpbmRvdztcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICAvLyBDb3B5IHNhbXBsZXMgd2l0aG91dCBwYWRkaW5nIHRvIHRoZSBvdXRwdXQgYnVmZmVyXG4gIHNhbXBsZXMuc2V0KCBuZXcgRmxvYXQzMkFycmF5KCBwYWRkZWRTYW1wbGVzLmJ1ZmZlciwgZnJhbWVTaXplLCBudW1TYW1wbGVzICkgKTtcblxuICAvLyBGcmVlIHBhZGRlZCBzYW1wbGUgYnVmZmVyXG4gIC8vIGRlbGV0ZSBbXSBwYWRkZWRTYW1wbGVzO1xuXG4gIHJldHVybiBzYW1wbGVzO1xufVxuIl0sIm5hbWVzIjpbIldpbmRvd01vZGUiXSwibWFwcGluZ3MiOiI7Ozs7Ozs7Ozs7Ozs7O1VBQWEsU0FBUyxHQUFHLE9BQU87VUFFbkIsaUJBQWlCLEdBQUcsRUFBRTtVQUN0QixpQkFBaUIsR0FBRyxFQUFFO1VBRXRCLFNBQVMsR0FBRyxLQUFLO1VBQ2pCLHVCQUF1QixHQUFHLEVBQUU7VUFDNUIsY0FBYyxHQUFHLFNBQVMsR0FBRyxFQUFFO1VBQy9CLGVBQWUsR0FBRyxjQUFjLEdBQUcsd0JBQXdCO1VBRTNELFFBQVEsR0FBRyxHQUFHO1VBQ2QsWUFBWSxHQUFHLElBQUk7QUFFcEJBO0lBQVosV0FBWSxVQUFVO1FBQ3BCLDJDQUFRLENBQUE7UUFDUiw2Q0FBUyxDQUFBO1FBQ1QsNkNBQVMsQ0FBQTtRQUNULDJDQUFRLENBQUE7SUFDVixDQUFDLEVBTFdBLGtCQUFVLEtBQVZBLGtCQUFVLFFBS3JCO1VBRVksYUFBYSxHQUFHO1FBQzNCLENBQUMs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
