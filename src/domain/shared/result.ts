export type Success<T> = { readonly success: true; readonly data: T };
export type Failure<E> = { readonly success: false; readonly error: E };

/**
 * Explicit, type-safe outcome of an operation that can fail for expected reasons.
 * Use cases and factories return a Result instead of throwing.
 */
export type Result<T, E> = Success<T> | Failure<E>;

export const ok = <T>(data: T): Success<T> => ({ success: true, data });

export const fail = <E>(error: E): Failure<E> => ({ success: false, error });
