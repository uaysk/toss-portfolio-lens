export type ApiError = {
  error?: {
    code?: string;
    message?: string;
    requestId?: string;
  };
};

export type Theme = "dark" | "light";
