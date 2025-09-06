const asyncHandler = (RequestHandler) => {
    return async (req, res, next) => {
      try {
        await RequestHandler(req, res, next);
      } catch (error) {
        next(error);
      }
    };
  };
  
  export { asyncHandler };