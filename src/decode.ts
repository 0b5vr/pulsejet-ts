import { bandToNumBins, frameSize, longWindowSize, mdctWindow, numBands, numShortWindowsPerFrame, numTotalBins, shortWindowSize, WindowMode } from './common';

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
export function decode( input: Uint8Array ): Float32Array {
  const inputView = new DataView( input.buffer, input.byteOffset, input.byteLength );
  let inputViewPtr = 0;

  // Skip tag and codec version
  inputViewPtr += 8;

  // Read frame count, determine number of samples, and allocate output sample buffer
  let numFrames = inputView.getUint16( inputViewPtr, true );
  inputViewPtr += 2; // sizeof u16
  const numSamples = numFrames * frameSize;
  const samples = new Float32Array( numSamples );

  // We're going to decode one more frame than we output, so adjust the frame count
  numFrames ++;

  // Set up and skip window mode stream
  let windowModePtr = inputViewPtr;
  inputViewPtr += numFrames;

  // Set up and skip quantized band bin stream
  let quantizedBandBinPtr = inputViewPtr;
  inputViewPtr += numFrames * numTotalBins;

  // Allocate padded sample buffer, and fill with silence
  const numPaddedSamples = numSamples + frameSize * 2;
  const paddedSamples = new Float32Array( numPaddedSamples );

  // Clear quantized band energy predictions
  const quantizedBandEnergyPredictions = new Uint8Array( numBands );

  // Decode frames
  for ( let frameIndex = 0; frameIndex < numFrames; frameIndex ++ ) {
    // Read window mode for this frame
    const windowMode: WindowMode = input[ windowModePtr ++ ];

    // Determine subframe configuration from window mode
    let numSubframes = 1;
    let subframeWindowOffset = 0;
    let subframeWindowSize = longWindowSize;
    if ( windowMode === WindowMode.Short ) {
      numSubframes = numShortWindowsPerFrame;
      subframeWindowOffset = longWindowSize / 4 - shortWindowSize / 4;
      subframeWindowSize = shortWindowSize;
    }

    // Decode subframe(s)
    for ( let subframeIndex = 0; subframeIndex < numSubframes; subframeIndex ++ ) {
      // Decode bands
      const windowBins = new Float32Array( frameSize );
      let bandBinsPtr = 0;
      for ( let bandIndex = 0; bandIndex < numBands; bandIndex ++ ) {
        // Decode band bins
        const numBins = bandToNumBins[ bandIndex ] / numSubframes;
        let numNonzeroBins = 0;
        for ( let binIndex = 0; binIndex < numBins; binIndex ++ ) {
          const binQ = inputView.getInt8( quantizedBandBinPtr ++ );
          if ( binQ ) {
            numNonzeroBins ++;
          }
          const bin = binQ;
          windowBins[ bandBinsPtr + binIndex ] = bin;
        }

        // If this band is significantly sparse, fill in (nearly) spectrally flat noise
        const binFill = numNonzeroBins / numBins;
        const noiseFillThreshold = 0.1;
        if ( binFill < noiseFillThreshold ) {
          const binSparsity = (noiseFillThreshold - binFill) / noiseFillThreshold;
          const noiseFillGain = binSparsity * binSparsity;
          for ( let binIndex = 0; binIndex < numBins; binIndex ++ ) {
            // Use the Math.random() instead of lcg
            const noiseSample = Math.random() * 2.0 - 1.0;
            windowBins[ bandBinsPtr + binIndex ] += noiseSample * noiseFillGain;
          }
        }

        // Decode band energy
        const quantizedBandEnergyResidual = input[ inputViewPtr ++ ];
        const quantizedBandEnergy = ( quantizedBandEnergyPredictions[ bandIndex ] + quantizedBandEnergyResidual ) & 255;
        quantizedBandEnergyPredictions[ bandIndex ] = quantizedBandEnergy;
        const bandEnergy = Math.pow( 2.0, quantizedBandEnergy / 64.0 * 40.0 - 20.0 ) * numBins;

        // Normalize band bins and scale by band energy
        const epsilon = 1e-27;
        let bandBinEnergy = epsilon;
        for ( let binIndex = 0; binIndex < numBins; binIndex ++ ) {
          const bin = windowBins[ bandBinsPtr + binIndex ];
          bandBinEnergy += bin * bin;
        }
        bandBinEnergy = Math.sqrt( bandBinEnergy );
        const binScale = bandEnergy / bandBinEnergy;
        for ( let binIndex = 0; binIndex < numBins; binIndex ++ ) {
          windowBins[ bandBinsPtr + binIndex ] *= binScale;
        }

        bandBinsPtr += numBins;
      }

      // Apply the IMDCT to the subframe bins, then apply the appropriate window to the resulting samples, and finally accumulate them into the padded output buffer
      const frameOffset = frameIndex * frameSize;
      const windowOffset = subframeWindowOffset + subframeIndex * subframeWindowSize / 2;
      for ( let n = 0; n < subframeWindowSize; n ++ ) {
        const nPlusHalf = n + 0.5;

        let sample = 0.0;
        for ( let k = 0; k < ( subframeWindowSize >> 1 ); k ++ ) {
          if ( windowBins[ k ] ) {
            sample += ( 2.0 / ( subframeWindowSize >> 1 ) ) * windowBins[ k ] * Math.cos( Math.PI / ( subframeWindowSize >> 1 ) * ( nPlusHalf + ( subframeWindowSize >> 2 ) ) * ( k + 0.5 ) );
          }
        }

        const window = mdctWindow( n, subframeWindowSize, windowMode );
        paddedSamples[ frameOffset + windowOffset + n ] += sample * window;
      }
    }
  }

  // Copy samples without padding to the output buffer
  samples.set( new Float32Array( paddedSamples.buffer, 4 * frameSize, numSamples ) );

  // Free padded sample buffer
  // delete [] paddedSamples;

  return samples;
}
