import {
  createApiError,
  type ApiErrorCode,
} from '@readable-studio/contracts';
import type { Request, RequestHandler, Response } from 'express';

import type { HostedRuntimeLease } from '../hosted-runtime-registry.js';
import { sendApiError } from '../http/response.js';

export type HostedRouteIdentity = {
  readonly displayName?: string;
  readonly sessionKey: string;
  readonly userKey: string;
};

export type HostedRequestState = {
  readonly bindingKey: string;
  readonly identity: HostedRouteIdentity;
  readonly lease: HostedRuntimeLease;
};

export type HostedIdentityRequestState = Omit<HostedRequestState, 'lease'>;

export class HostedHttpError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'HostedHttpError';
  }
}

export const noHostedInput: RequestHandler = (request, response, next) => {
  const contentLength = request.headers['content-length'];
  if (
    request.url.includes('?')
    || (contentLength != null && contentLength !== '0')
    || request.headers['transfer-encoding'] != null
  ) {
    hostedApiFailure(response, 400, 'BAD_REQUEST', 'hosted route does not accept input');
    return;
  }
  next();
};

export function exactHostedQuery(allowed: readonly string[]): RequestHandler {
  const keys = new Set(allowed);
  return (request, response, next) => {
    if (Object.keys(request.query).some((key) => !keys.has(key))) {
      hostedApiFailure(response, 400, 'BAD_REQUEST', 'hosted query contains unsupported fields');
      return;
    }
    if (
      request.headers['content-length'] != null
      || request.headers['transfer-encoding'] != null
    ) {
      hostedApiFailure(response, 400, 'BAD_REQUEST', 'hosted route does not accept a body');
      return;
    }
    next();
  };
}

export function hostedRequestState(response: Response): HostedRequestState {
  const state = response.locals.hosted as HostedRequestState | undefined;
  if (state == null) {
    throw new HostedHttpError(
      'HOSTED_AUTH_REQUIRED',
      'hosted authentication is required',
      401,
    );
  }
  return state;
}

export function hostedIdentityState(response: Response): HostedIdentityRequestState {
  const state = response.locals.hostedIdentity as HostedIdentityRequestState | undefined;
  if (state == null) {
    throw new HostedHttpError(
      'HOSTED_AUTH_REQUIRED',
      'hosted authentication is required',
      401,
    );
  }
  return state;
}

export function hostedRouteParam(request: Request, name: string): string {
  const value = request.params[name];
  if (typeof value !== 'string') {
    throw new HostedHttpError('BAD_REQUEST', 'hosted route parameter is invalid', 400);
  }
  return value;
}

export function hostedApiFailure(
  response: Response,
  status: number,
  code: ApiErrorCode,
  message: string,
  requestId?: string,
): void {
  sendApiError(
    response,
    status,
    createApiError(code, message, requestId === undefined ? {} : { requestId }),
  );
}
