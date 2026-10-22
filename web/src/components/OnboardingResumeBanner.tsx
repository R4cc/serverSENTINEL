import { Banner, Button } from "./UiPrimitives";

const onboardingSteps = ["Host", "Server", "Start", "Finish"] as const;

export function onboardingRecommendedStep(input: {
  serverCount: number;
  serverRunning: boolean;
}): 1 | 2 | 3 | 4 {
  if (input.serverCount === 0) return 1;
  return input.serverRunning ? 4 : 3;
}

function stepDescription(step: number) {
  if (step === 1) return "Choose the computer that will run your first Minecraft server.";
  if (step === 2) return "Create a new server or restore a serverSENTINEL export.";
  if (step === 3) return "Start the server and verify that its runtime is healthy.";
  return "Review optional integrations, then hand control over to the full panel.";
}

export function OnboardingResumeBanner({
  step,
  onResume
}: {
  step: 1 | 2 | 3 | 4;
  onResume(): void;
}) {
  return (
    <Banner
      className="onboardingResumeBanner"
      tone="info"
      title={`Initial setup · ${onboardingSteps[step - 1]}`}
      message={stepDescription(step)}
      action={<Button compact onClick={onResume}>Continue setup</Button>}
    />
  );
}

