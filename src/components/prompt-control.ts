export function shouldHandoffCoordinatorQuestion(params: {
  controlledBy: 'coordinator' | 'human' | undefined;
  questionActive: boolean;
  agentIdle: boolean;
  startupBlocking: boolean;
  autoTrustSettling: boolean;
  autoTrustHandled: boolean;
  recentPromptEcho: boolean;
}): boolean {
  return (
    params.controlledBy === 'coordinator' &&
    params.questionActive &&
    params.agentIdle &&
    !params.startupBlocking &&
    !params.autoTrustSettling &&
    !params.autoTrustHandled &&
    !params.recentPromptEcho
  );
}

export function shouldAckInitialPromptDelivery(params: {
  coordinatedBy: string | undefined;
  initialPrompt: string | undefined;
  sentText: string;
}): boolean {
  const initialPrompt = params.initialPrompt?.trim();
  return Boolean(params.coordinatedBy && initialPrompt && params.sentText.trim() === initialPrompt);
}

export function shouldRendererAutoSendInitialPrompt(params: {
  coordinatedBy: string | undefined;
  initialPrompt: string | undefined;
}): boolean {
  const initialPrompt = params.initialPrompt?.trim();
  return Boolean(initialPrompt && !params.coordinatedBy);
}
