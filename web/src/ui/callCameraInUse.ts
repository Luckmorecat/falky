import type { AppState } from '../app/store';

export const callCameraInUse = ({ voice }: AppState): boolean => voice.camera || !!voice.cameraStarting;
