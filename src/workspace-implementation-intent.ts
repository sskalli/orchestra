// Only a standalone approval can authorize a writable chat turn.
const standaloneApproval = /^(?:fix this|go ahead and implement that|implement that plan)[.!]?$/i;

export function requestsImplementation(text: string) {
  return standaloneApproval.test(text.trim());
}
