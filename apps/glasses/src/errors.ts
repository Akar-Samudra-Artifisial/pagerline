/** Non-2xx response (status 0 = network failure); `message` is the server's `{error}` text when present. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}
