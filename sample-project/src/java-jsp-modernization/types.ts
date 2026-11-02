export type ModernizationInput = {
  workspaceRoot: string;
  outputDir: string;
  requestHeaders?: Record<string, string>;
  forceValidationFail?: boolean;
};

export type AnalysisResult = {
  overview: string;
  javaContracts: string[];
  jspContracts: string[];
  crossLayerContracts: string[];
  preservationRules: string[];
  modernizationTargets: string[];
  risks: string[];
};

export type ValidationResult = {
  approved: boolean;
  confidence: number;
  preservedContracts: string[];
  missingCoverage: string[];
  warnings: string[];
  blockingIssues: string[];
};

export type RequirementsResult = {
  functionalRequirements: string[];
  compatibilityRequirements: string[];
  javaRequirements: string[];
  jspRequirements: string[];
  acceptanceCriteria: string[];
  unresolvedQuestions: string[];
};

export type DesignResult = {
  architectureSummary: string;
  javaDesignDecisions: string[];
  jspDesignDecisions: string[];
  compatibilityNotes: string[];
  migrationSequence: string[];
  testStrategy: string[];
};

export type ReimplementationResult = {
  javaFiles: Array<{
    path: string;
    content: string;
  }>;
  jspFiles: Array<{
    path: string;
    content: string;
  }>;
  migrationNotes: string[];
};
