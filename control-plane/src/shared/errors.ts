export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly pointer?: string,
  ) {
    super(message);
  }
}
export const notFound = (what: string) => new ApiError(404, 'not_found', `${what} not found`);
export const badRequest = (message: string, pointer?: string) => new ApiError(400, 'bad_request', message, pointer);
export const conflict = (message: string) => new ApiError(409, 'conflict', message);
export const unauthorized = () => new ApiError(401, 'unauthorized', 'sign in first');
