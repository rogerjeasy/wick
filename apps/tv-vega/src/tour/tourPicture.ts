/**
 * The door step's picture (tour/TourScreen.tsx): a bundled sample, made and
 * not photographed — the demo doorbell's parcel delivery
 * (docs/demo-door/NOTICE.md), at twice the size it is drawn. Nobody in it
 * is a real person. Kept apart, like home/posters.ts, because `require` of
 * an image only resolves in the bundler.
 */
import type { ImageSourcePropType } from '@amazon-devices/react-native-kepler';

/* eslint-disable @typescript-eslint/no-require-imports */
export const TOUR_DOOR_PICTURE: ImageSourcePropType = require('../../assets/image/tour-door.jpg') as ImageSourcePropType;
/* eslint-enable @typescript-eslint/no-require-imports */
