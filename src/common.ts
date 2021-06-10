export const sampleTag = 'PLSJ';

export const codecVersionMajor = 0;
export const codecVersionMinor = 1;

export const frameSize = 1024;
export const numShortWindowsPerFrame = 8;
export const longWindowSize = frameSize * 2;
export const shortWindowSize = longWindowSize / numShortWindowsPerFrame;

export const numBands = 20;
export const numTotalBins = 856;

export enum WindowMode {
  Long = 0,
  Short = 1,
  Start = 2,
  Stop = 3,
};

export const bandToNumBins = [
  8, 8, 8, 8, 8, 8, 8, 8, 16, 16, 24, 32, 32, 40, 48, 64, 80, 120, 144, 176,
];

export function vorbisWindow( nPlusHalf: number, size: number ): number {
  const sineWindow = Math.sin( Math.PI / size * nPlusHalf );
  return Math.sin( Math.PI / 2.0 * sineWindow * sineWindow );
}

export function mdctWindow( n: number, size: number, mode: WindowMode ): number {
  const nPlusHalf = n + 0.5;

  if ( mode === WindowMode.Start ) {
    const shortWindowOffset = longWindowSize * 3 / 4 - shortWindowSize / 4;
    if ( n >= shortWindowOffset + shortWindowSize / 2 ) {
      return 0.0;
    } else if ( n >= shortWindowOffset ) {
      return 1.0 - vorbisWindow( nPlusHalf - shortWindowOffset, shortWindowSize );
    } else if ( n >= longWindowSize / 2 ) {
      return 1.0;
    }
  } else if ( mode === WindowMode.Stop ) {
    const shortWindowOffset = longWindowSize / 4 - shortWindowSize / 4;
    if ( n < shortWindowOffset ) {
      return 0.0;
    } else if ( n < shortWindowOffset + shortWindowSize / 2 ) {
      return vorbisWindow( nPlusHalf - shortWindowOffset, shortWindowSize );
    } else if ( n < longWindowSize / 2 ) {
      return 1.0;
    }
  }

  return vorbisWindow( nPlusHalf, size );
}
