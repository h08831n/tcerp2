export const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001/api";

export class ApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function parseErrorMessage(response: Response): Promise<string> {
  try {
    const data = await response.json();
    if (typeof data?.message === "string" && data.message) return data.message;
    if (Array.isArray(data?.message) && data.message.length > 0) {
      return data.message.join("، ");
    }
  } catch {
    // ignore JSON parse failures
  }
  return response.status === 401
    ? "اطلاعات ورود نامعتبر است."
    : "خطایی در ارتباط با سرور رخ داد.";
}

/**
 * Client-side fetch helper.
 * - Sends cookies with every request (credentials: "include").
 * - On 401 (except for /auth/login itself), tries POST /auth/refresh once,
 *   then retries the original request once.
 * - Throws ApiError with the backend message on failure.
 */
export async function apiFetch(
  path: string,
  init: RequestInit = {},
  isRetry = false,
): Promise<Response> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    ...(init.body ? { "Content-Type": "application/json" } : {}),
    ...(init.headers as Record<string, string> | undefined),
  };

  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers,
    credentials: "include",
  });

  if (response.status === 401 && !isRetry && path !== "/auth/login") {
    const refreshResponse = await fetch(`${API_BASE_URL}/auth/refresh`, {
      method: "POST",
      credentials: "include",
    });

    if (refreshResponse.ok) {
      return apiFetch(path, init, true);
    }
  }

  if (!response.ok) {
    throw new ApiError(await parseErrorMessage(response), response.status);
  }

  return response;
}

/** Convenience JSON helper: returns parsed body for 2xx responses. */
export async function apiJson<T>(path: string, init: RequestInit = {}) {
  const response = await apiFetch(path, init);
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}
