/**
 * Volume sliders are linear 0-300%, but loudness is not.
 *
 * Feeding the slider value straight into HTMLMediaElement.volume made the
 * bottom half of the travel useless: 50% barely sounds quieter, and everything
 * interesting is crammed into the last few percent. Map the 0-100% part of the
 * slider onto a 50 dB range instead, which is roughly how a volume control is
 * expected to behave (10% is very quiet, 50% is noticeably quiet).
 *
 * Boost above 100% stays linear -- it is a gain node, and the curve is
 * continuous at 1.
 * @param value Slider value, 0 to 3
 * @returns Gain factor
 */
export function perceptualGain(value: number): number {
  if (!(value > 0)) return 0;
  if (value >= 1) return value;
  return Math.pow(10, ((value - 1) * 50) / 20);
}
