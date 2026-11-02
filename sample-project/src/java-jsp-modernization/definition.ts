import { type WorkflowDefinition } from "agentic-task-kit";
import { AnalyzeAssetsTask } from "./analyze-assets.js";
import { DesignModernizationTask } from "./design-modernization.js";
import { ExtractRequirementsTask } from "./extract-requirements.js";
import { RecoverTask } from "./recover.js";
import { ReimplementAssetsTask } from "./reimplement-assets.js";
import { ValidateAnalysisTask } from "./validate-analysis.js";

export const JavaJspModernizationWorkflow: WorkflowDefinition = {
  name: "sample-project-java-jsp-modernization",
  start: "analyze",
  end: "end",
  tasks: {
    analyze: new AnalyzeAssetsTask(),
    validate: new ValidateAnalysisTask(),
    requirements: new ExtractRequirementsTask(),
    design: new DesignModernizationTask(),
    reimplement: new ReimplementAssetsTask(),
    recover: new RecoverTask(),
  },
  transitions: {
    analyze: {
      success: "validate",
      fail: "recover",
    },
    validate: {
      success: "requirements",
      fail: "recover",
    },
    requirements: {
      success: "design",
      fail: "recover",
    },
    design: {
      success: "reimplement",
      fail: "recover",
    },
    reimplement: {
      success: "end",
      fail: "recover",
    },
    recover: {
      success: "end",
      fail: "end",
    },
  },
};
