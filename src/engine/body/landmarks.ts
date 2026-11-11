/**
 * MediaPipe Pose 输出的 33 个关键点里我们用到的那些。
 * "left / right" 指被拍的人自己的左右，不是画面的左右。
 */
export const LM = {
  nose: 0,
  leftEye: 2,
  rightEye: 5,
  leftEar: 7,
  rightEar: 8,
  leftShoulder: 11,
  rightShoulder: 12,
  leftElbow: 13,
  rightElbow: 14,
  leftWrist: 15,
  rightWrist: 16,
  leftPinky: 17,
  rightPinky: 18,
  leftIndex: 19,
  rightIndex: 20,
  leftHip: 23,
  rightHip: 24,
  leftKnee: 25,
  rightKnee: 26,
  leftAnkle: 27,
  rightAnkle: 28,
  leftHeel: 29,
  rightHeel: 30,
  leftFoot: 31,
  rightFoot: 32,
} as const;

export const LM_COUNT = 33;

/** 拟合尺度、判断"人在不在"时用的主干点：鼻、肩、肘、腕、髋、膝、踝。 */
export const CORE_LM: readonly number[] = [0, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28];
