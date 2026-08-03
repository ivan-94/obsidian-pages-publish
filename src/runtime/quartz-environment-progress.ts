export type QuartzEnvironmentProgressStage =
  | 'downloading-runtime'
  | 'installing-runtime'
  | 'downloading-engine'
  | 'installing-engine'
  | 'smoke-testing';

export type QuartzEnvironmentProgressReporter = (
  stage: QuartzEnvironmentProgressStage,
) => void;
