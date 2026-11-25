// Reserve room for playback controls instead of sizing the pitch from width alone.
export function playbackPitchHeight({viewportHeight,pitchWidth,pitchTop,controlsHeight,controlsMargins=0,mobile=false}){
 const natural=pitchWidth/(mobile?1.5:1.6);
 const available=viewportHeight-pitchTop-controlsHeight-controlsMargins-16;
 return Math.floor(Math.min(natural,Math.max(96,available)));
}

// Keep the fitted field width and give half of its original side padding to the charts.
export function optimizerPitchWidth(canvasWidth, canvasHeight, pitchLength, pitchWidth) {
 const fieldWidth = pitchLength * Math.min((canvasWidth - 48) / pitchLength, (canvasHeight - 40) / pitchWidth);
 return Math.round((canvasWidth + fieldWidth) / 2);
}
