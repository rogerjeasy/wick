/**
 * Ask by voice: the AudioWorklet that hands the page the microphone's
 * samples, a frame at a time (voice.js CAPTURE_WORKLET_URL). It keeps
 * nothing: each frame is posted to the page as it comes, and the page stops
 * the microphone the moment the utterance ends.
 */
class WickCapture extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel && channel.length) this.port.postMessage(channel.slice(0));
    return true;
  }
}
registerProcessor('wick-capture', WickCapture);
