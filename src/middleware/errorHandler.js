/**
 * Global error handling middleware
 */
export function errorHandler(err, req, res, next) {
  console.error('[Error]', err);

  const status = err.status || err.statusCode || 500;
  const message = status >= 500
    ? 'Internal Server Error'
    : (err.message || 'Request failed');

  res.status(status).json({
    error: {
      message,
      status
    }
  });
}

/**
 * 404 Not Found fallback middleware
 */
export function notFoundHandler(req, res) {
  res.status(404).json({
    error: {
      message: `Route not found: ${req.method} ${req.originalUrl}`,
      status: 404
    }
  });
}
