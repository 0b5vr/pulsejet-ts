/*!
 * pulsejet-ts v0.0.1
 * 
 *
 * Copyright (c) 2021 FMS_Cat
 * pulsejet-ts is distributed under MIT License
 * https://github.com/FMS-Cat/pulsejet-ts/blob/master/LICENSE
 */
const sampleTag = 'PLSJ';
const codecVersionMajor = 0;
const codecVersionMinor = 1;
const frameSize = 1024;
const numShortWindowsPerFrame = 8;
const longWindowSize = frameSize * 2;
const shortWindowSize = longWindowSize / numShortWindowsPerFrame;
const numBands = 20;
const numTotalBins = 856;
var WindowMode;
(function (WindowMode) {
    WindowMode[WindowMode["Long"] = 0] = "Long";
    WindowMode[WindowMode["Short"] = 1] = "Short";
    WindowMode[WindowMode["Start"] = 2] = "Start";
    WindowMode[WindowMode["Stop"] = 3] = "Stop";
})(WindowMode || (WindowMode = {}));
const bandToNumBins = [
    8, 8, 8, 8, 8, 8, 8, 8, 16, 16, 24, 32, 32, 40, 48, 64, 80, 120, 144, 176,
];
function vorbisWindow(nPlusHalf, size) {
    const sineWindow = Math.sin(Math.PI / size * nPlusHalf);
    return Math.sin(Math.PI / 2.0 * sineWindow * sineWindow);
}
function mdctWindow(n, size, mode) {
    const nPlusHalf = n + 0.5;
    if (mode === WindowMode.Start) {
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
    else if (mode === WindowMode.Stop) {
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
        if (windowMode === WindowMode.Short) {
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

export { WindowMode, bandToNumBins, codecVersionMajor, codecVersionMinor, decode, frameSize, longWindowSize, mdctWindow, numBands, numShortWindowsPerFrame, numTotalBins, sampleTag, shortWindowSize, vorbisWindow };
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicHVsc2VqZXQubW9kdWxlLmpzIiwic291cmNlcyI6WyIuLi9zcmMvY29tbW9uLnRzIiwiLi4vc3JjL2RlY29kZS50cyJdLCJzb3VyY2VzQ29udGVudCI6WyJleHBvcnQgY29uc3Qgc2FtcGxlVGFnID0gJ1BMU0onO1xuXG5leHBvcnQgY29uc3QgY29kZWNWZXJzaW9uTWFqb3IgPSAwO1xuZXhwb3J0IGNvbnN0IGNvZGVjVmVyc2lvbk1pbm9yID0gMTtcblxuZXhwb3J0IGNvbnN0IGZyYW1lU2l6ZSA9IDEwMjQ7XG5leHBvcnQgY29uc3QgbnVtU2hvcnRXaW5kb3dzUGVyRnJhbWUgPSA4O1xuZXhwb3J0IGNvbnN0IGxvbmdXaW5kb3dTaXplID0gZnJhbWVTaXplICogMjtcbmV4cG9ydCBjb25zdCBzaG9ydFdpbmRvd1NpemUgPSBsb25nV2luZG93U2l6ZSAvIG51bVNob3J0V2luZG93c1BlckZyYW1lO1xuXG5leHBvcnQgY29uc3QgbnVtQmFuZHMgPSAyMDtcbmV4cG9ydCBjb25zdCBudW1Ub3RhbEJpbnMgPSA4NTY7XG5cbmV4cG9ydCBlbnVtIFdpbmRvd01vZGUge1xuICBMb25nID0gMCxcbiAgU2hvcnQgPSAxLFxuICBTdGFydCA9IDIsXG4gIFN0b3AgPSAzLFxufTtcblxuZXhwb3J0IGNvbnN0IGJhbmRUb051bUJpbnMgPSBbXG4gIDgsIDgsIDgsIDgsIDgsIDgsIDgsIDgsIDE2LCAxNiwgMjQsIDMyLCAzMiwgNDAsIDQ4LCA2NCwgODAsIDEyMCwgMTQ0LCAxNzYsXG5dO1xuXG5leHBvcnQgZnVuY3Rpb24gdm9yYmlzV2luZG93KCBuUGx1c0hhbGY6IG51bWJlciwgc2l6ZTogbnVtYmVyICk6IG51bWJlciB7XG4gIGNvbnN0IHNpbmVXaW5kb3cgPSBNYXRoLnNpbiggTWF0aC5QSSAvIHNpemUgKiBuUGx1c0hhbGYgKTtcbiAgcmV0dXJuIE1hdGguc2luKCBNYXRoLlBJIC8gMi4wICogc2luZVdpbmRvdyAqIHNpbmVXaW5kb3cgKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIG1kY3RXaW5kb3coIG46IG51bWJlciwgc2l6ZTogbnVtYmVyLCBtb2RlOiBXaW5kb3dNb2RlICk6IG51bWJlciB7XG4gIGNvbnN0IG5QbHVzSGFsZiA9IG4gKyAwLjU7XG5cbiAgaWYgKCBtb2RlID09PSBXaW5kb3dNb2RlLlN0YXJ0ICkge1xuICAgIGNvbnN0IHNob3J0V2luZG93T2Zmc2V0ID0gbG9uZ1dpbmRvd1NpemUgKiAzIC8gNCAtIHNob3J0V2luZG93U2l6ZSAvIDQ7XG4gICAgaWYgKCBuID49IHNob3J0V2luZG93T2Zmc2V0ICsgc2hvcnRXaW5kb3dTaXplIC8gMiApIHtcbiAgICAgIHJldHVybiAwLjA7XG4gICAgfSBlbHNlIGlmICggbiA+PSBzaG9ydFdpbmRvd09mZnNldCApIHtcbiAgICAgIHJldHVybiAxLjAgLSB2b3JiaXNXaW5kb3coIG5QbHVzSGFsZiAtIHNob3J0V2luZG93T2Zmc2V0LCBzaG9ydFdpbmRvd1NpemUgKTtcbiAgICB9IGVsc2UgaWYgKCBuID49IGxvbmdXaW5kb3dTaXplIC8gMiApIHtcbiAgICAgIHJldHVybiAxLjA7XG4gICAgfVxuICB9IGVsc2UgaWYgKCBtb2RlID09PSBXaW5kb3dNb2RlLlN0b3AgKSB7XG4gICAgY29uc3Qgc2hvcnRXaW5kb3dPZmZzZXQgPSBsb25nV2luZG93U2l6ZSAvIDQgLSBzaG9ydFdpbmRvd1NpemUgLyA0O1xuICAgIGlmICggbiA8IHNob3J0V2luZG93T2Zmc2V0ICkge1xuICAgICAgcmV0dXJuIDAuMDtcbiAgICB9IGVsc2UgaWYgKCBuIDwgc2hvcnRXaW5kb3dPZmZzZXQgKyBzaG9ydFdpbmRvd1NpemUgLyAyICkge1xuICAgICAgcmV0dXJuIHZvcmJpc1dpbmRvdyggblBsdXNIYWxmIC0gc2hvcnRXaW5kb3dPZmZzZXQsIHNob3J0V2luZG93U2l6ZSApO1xuICAgIH0gZWxzZSBpZiAoIG4gPCBsb25nV2luZG93U2l6ZSAvIDIgKSB7XG4gICAgICByZXR1cm4gMS4wO1xuICAgIH1cbiAgfVxuXG4gIHJldHVybiB2b3JiaXNXaW5kb3coIG5QbHVzSGFsZiwgc2l6ZSApO1xufVxuIiwiaW1wb3J0IHsgYmFuZFRvTnVtQmlucywgZnJhbWVTaXplLCBsb25nV2luZG93U2l6ZSwgbWRjdFdpbmRvdywgbnVtQmFuZHMsIG51bVNob3J0V2luZG93c1BlckZyYW1lLCBudW1Ub3RhbEJpbnMsIHNob3J0V2luZG93U2l6ZSwgV2luZG93TW9kZSB9IGZyb20gJy4vY29tbW9uJztcblxuLyoqXG4gKiBEZWNvZGVzIGFuIGVuY29kZWQgcHVsc2VqZXQgc2FtcGxlIGludG8gYSBuZXdseS1hbGxvY2F0ZWQgYnVmZmVyLlxuICpcbiAqIFRoaXMgZnVuY3Rpb24gaXMgb3B0aW1pemVkIGZvciBzaXplIGFuZCBkZXNpZ25lZCB0byBiZSBjb21waWxlZCBpbiBhXG4gKiBzaXplLWNvbnN0cmFpbmVkIGVudmlyb25tZW50LiBJbiBzdWNoIGVudmlyb25tZW50cywgaXQncyBjb21tb24gbm90XG4gKiB0byBoYXZlIGFjY2VzcyB0byBhbGwgb2YgdGhlIHJlcXVpcmVkIG1hdGggZnVuY3Rpb25zLCBhbmQgaW5zdGVhZFxuICogaW1wbGVtZW50IHRoZW0gYnkgaGFuZC4gRm9yIHRoaXMgcmVhc29uLCB0aGlzIGRlY29kZXIgZG9lcyBub3RcbiAqIGRlcGVuZCBvbiBhbnkgc3VjaCBmdW5jdGlvbnMgZGlyZWN0bHksIGFuZCBpbnN0ZWFkIGV4cGVjdHMgdGhhdFxuICogYENvc0ZgLCBgRXhwMkZgLCBgU2luRmAsIGFuZCBgU3FydEZgIGZ1bmN0aW9ucyBhcmUgZGVmaW5lZCBpbiB0aGVcbiAqIGBQdWxzZWpldDo6U2hpbXNgIG5hbWVzcGFjZSBiZWZvcmUgaW5jbHVkaW5nIHJlbGV2YW50IHB1bHNlamV0XG4gKiBoZWFkZXIocykuIHB1bHNlamV0IGV4cGVjdHMgdGhhdCB0aGVzZSBmdW5jdGlvbnMgYmVoYXZlIHNpbWlsYXJseVxuICogdG8gdGhlIGNvcnJlc3BvbmRpbmcgc2ltaWxhcmx5LW5hbWVkIGNtYXRoIGZ1bmN0aW9ucy4gVGhpcyBzaGltXG4gKiBtZWNoYW5pc20gY2FuIGFsc28gYmUgdXNlZCB0byBwcm92aWRlIGxlc3MgYWNjdXJhdGUsIHNwZWVkLW9wdGltaXplZFxuICogdmVyc2lvbnMgb2YgdGhlc2UgZnVuY3Rpb25zIGlmIGRlc2lyZWQuXG4gKlxuICogQWRkaXRpb25hbGx5LCB0aGlzIGZ1bmN0aW9uIHdpbGwgbm90IHBlcmZvcm0gYW55IGVycm9yIGNoZWNraW5nIG9yXG4gKiBoYW5kbGluZy4gVGhlIGluY2x1ZGVkIG1ldGFkYXRhIEFQSSBjYW4gYmUgdXNlZCBmb3IgaGlnaC1sZXZlbCBlcnJvclxuICogY2hlY2tpbmcgYmVmb3JlIGRlY29kaW5nIHRha2VzIHBsYWNlIGlmIHJlcXVpcmVkIChhbGJlaXQgbm90IGluIGFcbiAqIG5vbi1zaXplLWNvbnN0cmFpbmVkIGVudmlyb25tZW50KS5cbiAqXG4gKiBAcGFyYW0gaW5wdXQgRW5jb2RlZCBwdWxzZWpldCBieXRlIHN0cmVhbS5cbiAqIEByZXR1cm4gRGVjb2RlZCBzYW1wbGVzIGluIHRoZSBbLTEsIDFdIHJhbmdlIChub3JtYWxpemVkKS5cbiAqICAgICAgICAgVGhpcyBidWZmZXIgaXMgYWxsb2NhdGVkIGJ5IGBuZXcgW11gIGFuZCBzaG91bGQgYmUgZnJlZWRcbiAqICAgICAgICAgdXNpbmcgYGRlbGV0ZSBbXWAuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBkZWNvZGUoIGlucHV0OiBVaW50OEFycmF5ICk6IEZsb2F0MzJBcnJheSB7XG4gIGNvbnN0IGlucHV0VmlldyA9IG5ldyBEYXRhVmlldyggaW5wdXQuYnVmZmVyLCBpbnB1dC5ieXRlT2Zmc2V0LCBpbnB1dC5ieXRlTGVuZ3RoICk7XG4gIGxldCBpbnB1dFZpZXdQdHIgPSAwO1xuXG4gIC8vIFNraXAgdGFnIGFuZCBjb2RlYyB2ZXJzaW9uXG4gIGlucHV0Vmlld1B0ciArPSA4O1xuXG4gIC8vIFJlYWQgZnJhbWUgY291bnQsIGRldGVybWluZSBudW1iZXIgb2Ygc2FtcGxlcywgYW5kIGFsbG9jYXRlIG91dHB1dCBzYW1wbGUgYnVmZmVyXG4gIGxldCBudW1GcmFtZXMgPSBpbnB1dFZpZXcuZ2V0VWludDE2KCBpbnB1dFZpZXdQdHIsIHRydWUgKTtcbiAgaW5wdXRWaWV3UHRyICs9IDI7IC8vIHNpemVvZiB1MTZcbiAgY29uc3QgbnVtU2FtcGxlcyA9IG51bUZyYW1lcyAqIGZyYW1lU2l6ZTtcbiAgY29uc3Qgc2FtcGxlcyA9IG5ldyBGbG9hdDMyQXJyYXkoIG51bVNhbXBsZXMgKTtcblxuICAvLyBXZSdyZSBnb2luZyB0byBkZWNvZGUgb25lIG1vcmUgZnJhbWUgdGhhbiB3ZSBvdXRwdXQsIHNvIGFkanVzdCB0aGUgZnJhbWUgY291bnRcbiAgbnVtRnJhbWVzICsrO1xuXG4gIC8vIFNldCB1cCBhbmQgc2tpcCB3aW5kb3cgbW9kZSBzdHJlYW1cbiAgbGV0IHdpbmRvd01vZGVQdHIgPSBpbnB1dFZpZXdQdHI7XG4gIGlucHV0Vmlld1B0ciArPSBudW1GcmFtZXM7XG5cbiAgLy8gU2V0IHVwIGFuZCBza2lwIHF1YW50aXplZCBiYW5kIGJpbiBzdHJlYW1cbiAgbGV0IHF1YW50aXplZEJhbmRCaW5QdHIgPSBpbnB1dFZpZXdQdHI7XG4gIGlucHV0Vmlld1B0ciArPSBudW1GcmFtZXMgKiBudW1Ub3RhbEJpbnM7XG5cbiAgLy8gQWxsb2NhdGUgcGFkZGVkIHNhbXBsZSBidWZmZXIsIGFuZCBmaWxsIHdpdGggc2lsZW5jZVxuICBjb25zdCBudW1QYWRkZWRTYW1wbGVzID0gbnVtU2FtcGxlcyArIGZyYW1lU2l6ZSAqIDI7XG4gIGNvbnN0IHBhZGRlZFNhbXBsZXMgPSBuZXcgRmxvYXQzMkFycmF5KCBudW1QYWRkZWRTYW1wbGVzICk7XG5cbiAgLy8gQ2xlYXIgcXVhbnRpemVkIGJhbmQgZW5lcmd5IHByZWRpY3Rpb25zXG4gIGNvbnN0IHF1YW50aXplZEJhbmRFbmVyZ3lQcmVkaWN0aW9ucyA9IG5ldyBVaW50OEFycmF5KCBudW1CYW5kcyApO1xuXG4gIC8vIERlY29kZSBmcmFtZXNcbiAgZm9yICggbGV0IGZyYW1lSW5kZXggPSAwOyBmcmFtZUluZGV4IDwgbnVtRnJhbWVzOyBmcmFtZUluZGV4ICsrICkge1xuICAgIC8vIFJlYWQgd2luZG93IG1vZGUgZm9yIHRoaXMgZnJhbWVcbiAgICBjb25zdCB3aW5kb3dNb2RlOiBXaW5kb3dNb2RlID0gaW5wdXRbIHdpbmRvd01vZGVQdHIgKysgXTtcblxuICAgIC8vIERldGVybWluZSBzdWJmcmFtZSBjb25maWd1cmF0aW9uIGZyb20gd2luZG93IG1vZGVcbiAgICBsZXQgbnVtU3ViZnJhbWVzID0gMTtcbiAgICBsZXQgc3ViZnJhbWVXaW5kb3dPZmZzZXQgPSAwO1xuICAgIGxldCBzdWJmcmFtZVdpbmRvd1NpemUgPSBsb25nV2luZG93U2l6ZTtcbiAgICBpZiAoIHdpbmRvd01vZGUgPT09IFdpbmRvd01vZGUuU2hvcnQgKSB7XG4gICAgICBudW1TdWJmcmFtZXMgPSBudW1TaG9ydFdpbmRvd3NQZXJGcmFtZTtcbiAgICAgIHN1YmZyYW1lV2luZG93T2Zmc2V0ID0gbG9uZ1dpbmRvd1NpemUgLyA0IC0gc2hvcnRXaW5kb3dTaXplIC8gNDtcbiAgICAgIHN1YmZyYW1lV2luZG93U2l6ZSA9IHNob3J0V2luZG93U2l6ZTtcbiAgICB9XG5cbiAgICAvLyBEZWNvZGUgc3ViZnJhbWUocylcbiAgICBmb3IgKCBsZXQgc3ViZnJhbWVJbmRleCA9IDA7IHN1YmZyYW1lSW5kZXggPCBudW1TdWJmcmFtZXM7IHN1YmZyYW1lSW5kZXggKysgKSB7XG4gICAgICAvLyBEZWNvZGUgYmFuZHNcbiAgICAgIGNvbnN0IHdpbmRvd0JpbnMgPSBuZXcgRmxvYXQzMkFycmF5KCBmcmFtZVNpemUgKTtcbiAgICAgIGxldCBiYW5kQmluc1B0ciA9IDA7XG4gICAgICBmb3IgKCBsZXQgYmFuZEluZGV4ID0gMDsgYmFuZEluZGV4IDwgbnVtQmFuZHM7IGJhbmRJbmRleCArKyApIHtcbiAgICAgICAgLy8gRGVjb2RlIGJhbmQgYmluc1xuICAgICAgICBjb25zdCBudW1CaW5zID0gYmFuZFRvTnVtQmluc1sgYmFuZEluZGV4IF0gLyBudW1TdWJmcmFtZXM7XG4gICAgICAgIGxldCBudW1Ob256ZXJvQmlucyA9IDA7XG4gICAgICAgIGZvciAoIGxldCBiaW5JbmRleCA9IDA7IGJpbkluZGV4IDwgbnVtQmluczsgYmluSW5kZXggKysgKSB7XG4gICAgICAgICAgY29uc3QgYmluUSA9IGlucHV0Vmlldy5nZXRJbnQ4KCBxdWFudGl6ZWRCYW5kQmluUHRyICsrICk7XG4gICAgICAgICAgaWYgKCBiaW5RICkge1xuICAgICAgICAgICAgbnVtTm9uemVyb0JpbnMgKys7XG4gICAgICAgICAgfVxuICAgICAgICAgIGNvbnN0IGJpbiA9IGJpblE7XG4gICAgICAgICAgd2luZG93Qmluc1sgYmFuZEJpbnNQdHIgKyBiaW5JbmRleCBdID0gYmluO1xuICAgICAgICB9XG5cbiAgICAgICAgLy8gSWYgdGhpcyBiYW5kIGlzIHNpZ25pZmljYW50bHkgc3BhcnNlLCBmaWxsIGluIChuZWFybHkpIHNwZWN0cmFsbHkgZmxhdCBub2lzZVxuICAgICAgICBjb25zdCBiaW5GaWxsID0gbnVtTm9uemVyb0JpbnMgLyBudW1CaW5zO1xuICAgICAgICBjb25zdCBub2lzZUZpbGxUaHJlc2hvbGQgPSAwLjE7XG4gICAgICAgIGlmICggYmluRmlsbCA8IG5vaXNlRmlsbFRocmVzaG9sZCApIHtcbiAgICAgICAgICBjb25zdCBiaW5TcGFyc2l0eSA9IChub2lzZUZpbGxUaHJlc2hvbGQgLSBiaW5GaWxsKSAvIG5vaXNlRmlsbFRocmVzaG9sZDtcbiAgICAgICAgICBjb25zdCBub2lzZUZpbGxHYWluID0gYmluU3BhcnNpdHkgKiBiaW5TcGFyc2l0eTtcbiAgICAgICAgICBmb3IgKCBsZXQgYmluSW5kZXggPSAwOyBiaW5JbmRleCA8IG51bUJpbnM7IGJpbkluZGV4ICsrICkge1xuICAgICAgICAgICAgLy8gVXNlIHRoZSBNYXRoLnJhbmRvbSgpIGluc3RlYWQgb2YgbGNnXG4gICAgICAgICAgICBjb25zdCBub2lzZVNhbXBsZSA9IE1hdGgucmFuZG9tKCkgKiAyLjAgLSAxLjA7XG4gICAgICAgICAgICB3aW5kb3dCaW5zWyBiYW5kQmluc1B0ciArIGJpbkluZGV4IF0gKz0gbm9pc2VTYW1wbGUgKiBub2lzZUZpbGxHYWluO1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIC8vIERlY29kZSBiYW5kIGVuZXJneVxuICAgICAgICBjb25zdCBxdWFudGl6ZWRCYW5kRW5lcmd5UmVzaWR1YWwgPSBpbnB1dFsgaW5wdXRWaWV3UHRyICsrIF07XG4gICAgICAgIGNvbnN0IHF1YW50aXplZEJhbmRFbmVyZ3kgPSAoIHF1YW50aXplZEJhbmRFbmVyZ3lQcmVkaWN0aW9uc1sgYmFuZEluZGV4IF0gKyBxdWFudGl6ZWRCYW5kRW5lcmd5UmVzaWR1YWwgKSAmIDI1NTtcbiAgICAgICAgcXVhbnRpemVkQmFuZEVuZXJneVByZWRpY3Rpb25zWyBiYW5kSW5kZXggXSA9IHF1YW50aXplZEJhbmRFbmVyZ3k7XG4gICAgICAgIGNvbnN0IGJhbmRFbmVyZ3kgPSBNYXRoLnBvdyggMi4wLCBxdWFudGl6ZWRCYW5kRW5lcmd5IC8gNjQuMCAqIDQwLjAgLSAyMC4wICkgKiBudW1CaW5zO1xuXG4gICAgICAgIC8vIE5vcm1hbGl6ZSBiYW5kIGJpbnMgYW5kIHNjYWxlIGJ5IGJhbmQgZW5lcmd5XG4gICAgICAgIGNvbnN0IGVwc2lsb24gPSAxZS0yNztcbiAgICAgICAgbGV0IGJhbmRCaW5FbmVyZ3kgPSBlcHNpbG9uO1xuICAgICAgICBmb3IgKCBsZXQgYmluSW5kZXggPSAwOyBiaW5JbmRleCA8IG51bUJpbnM7IGJpbkluZGV4ICsrICkge1xuICAgICAgICAgIGNvbnN0IGJpbiA9IHdpbmRvd0JpbnNbIGJhbmRCaW5zUHRyICsgYmluSW5kZXggXTtcbiAgICAgICAgICBiYW5kQmluRW5lcmd5ICs9IGJpbiAqIGJpbjtcbiAgICAgICAgfVxuICAgICAgICBiYW5kQmluRW5lcmd5ID0gTWF0aC5zcXJ0KCBiYW5kQmluRW5lcmd5ICk7XG4gICAgICAgIGNvbnN0IGJpblNjYWxlID0gYmFuZEVuZXJneSAvIGJhbmRCaW5FbmVyZ3k7XG4gICAgICAgIGZvciAoIGxldCBiaW5JbmRleCA9IDA7IGJpbkluZGV4IDwgbnVtQmluczsgYmluSW5kZXggKysgKSB7XG4gICAgICAgICAgd2luZG93Qmluc1sgYmFuZEJpbnNQdHIgKyBiaW5JbmRleCBdICo9IGJpblNjYWxlO1xuICAgICAgICB9XG5cbiAgICAgICAgYmFuZEJpbnNQdHIgKz0gbnVtQmlucztcbiAgICAgIH1cblxuICAgICAgLy8gQXBwbHkgdGhlIElNRENUIHRvIHRoZSBzdWJmcmFtZSBiaW5zLCB0aGVuIGFwcGx5IHRoZSBhcHByb3ByaWF0ZSB3aW5kb3cgdG8gdGhlIHJlc3VsdGluZyBzYW1wbGVzLCBhbmQgZmluYWxseSBhY2N1bXVsYXRlIHRoZW0gaW50byB0aGUgcGFkZGVkIG91dHB1dCBidWZmZXJcbiAgICAgIGNvbnN0IGZyYW1lT2Zmc2V0ID0gZnJhbWVJbmRleCAqIGZyYW1lU2l6ZTtcbiAgICAgIGNvbnN0IHdpbmRvd09mZnNldCA9IHN1YmZyYW1lV2luZG93T2Zmc2V0ICsgc3ViZnJhbWVJbmRleCAqIHN1YmZyYW1lV2luZG93U2l6ZSAvIDI7XG4gICAgICBmb3IgKCBsZXQgbiA9IDA7IG4gPCBzdWJmcmFtZVdpbmRvd1NpemU7IG4gKysgKSB7XG4gICAgICAgIGNvbnN0IG5QbHVzSGFsZiA9IG4gKyAwLjU7XG5cbiAgICAgICAgbGV0IHNhbXBsZSA9IDAuMDtcbiAgICAgICAgZm9yICggbGV0IGsgPSAwOyBrIDwgKCBzdWJmcmFtZVdpbmRvd1NpemUgPj4gMSApOyBrICsrICkge1xuICAgICAgICAgIGlmICggd2luZG93Qmluc1sgayBdICkge1xuICAgICAgICAgICAgc2FtcGxlICs9ICggMi4wIC8gKCBzdWJmcmFtZVdpbmRvd1NpemUgPj4gMSApICkgKiB3aW5kb3dCaW5zWyBrIF0gKiBNYXRoLmNvcyggTWF0aC5QSSAvICggc3ViZnJhbWVXaW5kb3dTaXplID4+IDEgKSAqICggblBsdXNIYWxmICsgKCBzdWJmcmFtZVdpbmRvd1NpemUgPj4gMiApICkgKiAoIGsgKyAwLjUgKSApO1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIGNvbnN0IHdpbmRvdyA9IG1kY3RXaW5kb3coIG4sIHN1YmZyYW1lV2luZG93U2l6ZSwgd2luZG93TW9kZSApO1xuICAgICAgICBwYWRkZWRTYW1wbGVzWyBmcmFtZU9mZnNldCArIHdpbmRvd09mZnNldCArIG4gXSArPSBzYW1wbGUgKiB3aW5kb3c7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgLy8gQ29weSBzYW1wbGVzIHdpdGhvdXQgcGFkZGluZyB0byB0aGUgb3V0cHV0IGJ1ZmZlclxuICBzYW1wbGVzLnNldCggbmV3IEZsb2F0MzJBcnJheSggcGFkZGVkU2FtcGxlcy5idWZmZXIsIGZyYW1lU2l6ZSwgbnVtU2FtcGxlcyApICk7XG5cbiAgLy8gRnJlZSBwYWRkZWQgc2FtcGxlIGJ1ZmZlclxuICAvLyBkZWxldGUgW10gcGFkZGVkU2FtcGxlcztcblxuICByZXR1cm4gc2FtcGxlcztcbn1cbiJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7Ozs7OztNQUFhLFNBQVMsR0FBRyxPQUFPO01BRW5CLGlCQUFpQixHQUFHLEVBQUU7TUFDdEIsaUJBQWlCLEdBQUcsRUFBRTtNQUV0QixTQUFTLEdBQUcsS0FBSztNQUNqQix1QkFBdUIsR0FBRyxFQUFFO01BQzVCLGNBQWMsR0FBRyxTQUFTLEdBQUcsRUFBRTtNQUMvQixlQUFlLEdBQUcsY0FBYyxHQUFHLHdCQUF3QjtNQUUzRCxRQUFRLEdBQUcsR0FBRztNQUNkLFlBQVksR0FBRyxJQUFJO0lBRXBCO0FBQVosV0FBWSxVQUFVO0lBQ3BCLDJDQUFRLENBQUE7SUFDUiw2Q0FBUyxDQUFBO0lBQ1QsNkNBQVMsQ0FBQTtJQUNULDJDQUFRLENBQUE7QUFDVixDQUFDLEVBTFcsVUFBVSxLQUFWLFVBQVUsUUFLckI7TUFFWSxhQUFhLEdBQUc7SUFDM0IsQ0FBQyxFQUFFLENBQUMsRUFBRSxD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
