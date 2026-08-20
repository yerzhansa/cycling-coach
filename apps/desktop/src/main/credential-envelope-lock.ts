const credentialEnvelopeLockProof = Symbol("credential-envelope-lock-proof");

export interface CredentialEnvelopeLockProof {
  readonly [credentialEnvelopeLockProof]: true;
}

export type SerializeCredentialEnvelopeMutation = <T>(
  operation: (proof: CredentialEnvelopeLockProof) => Promise<T>,
) => Promise<T>;

export function createCredentialEnvelopeMutationLock(): SerializeCredentialEnvelopeMutation {
  let queue = Promise.resolve();
  const proof = Object.freeze({
    [credentialEnvelopeLockProof]: true as const,
  });
  return <T>(operation: (current: CredentialEnvelopeLockProof) => Promise<T>): Promise<T> => {
    const result = queue.then(
      () => operation(proof),
      () => operation(proof),
    );
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
}
