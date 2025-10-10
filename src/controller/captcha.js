import {asyncHandler} from "../utility/AsyncHandler.js";
import fetch from "node-fetch";
import { ApiResponse } from "../utility/ApiResponse.js";
import { ApiError } from "../utility/ApiError.js"

export const verifyCaptcha = asyncHandler(async (req, res, next) => {
  const { token, action } = req.body;
  // Validate token existence
  if (!token || token === "undefined" || token === null) {
    throw new ApiError(400, "Captcha token missing");
  }

  const secretKey = process.env.RECAPTCHA_SECRET_KEY;

  // Validate secret key
  if (!secretKey) {
    throw new ApiError(500, "reCAPTCHA secret key not configured");
  }

  try {
    // Verify with Google reCAPTCHA
    const response = await fetch(
      "https://www.google.com/recaptcha/api/siteverify",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          secret: secretKey,
          response: token,
        }),
      }
    );

    const data = await response.json();

    // Check if verification was successful
    if (!data.success) {
      throw new ApiError(
        400,
        "Captcha verification failed",
        data["error-codes"]
      );
    }

    // Check score threshold (for v3)
    const threshold = 0.2;
    if (data.score !== undefined && data.score < threshold) {
      throw new ApiError(403, "Low reCAPTCHA score - possible bot", [], {
        score: data.score,
      });
    }

    // Verify action matches (for v3)
    if (action && data.action && data.action !== action) {
      throw new ApiError(400, "Captcha action mismatch");
    }

    // Success - attach verification data to request
    req.captchaVerified = true;
    req.captchaScore = data.score;

    // Either continue to next middleware or send success response
    return res
      .status(200)
      .json(
        new ApiResponse(
          200,
          { verified: true, score: data.score },
          "Captcha verified successfully"
        )
      );
  } catch (error) {
    // If it's already an ApiError, throw it
    if (error instanceof ApiError) {
      throw error;
    }
    // Otherwise wrap it
    throw new ApiError(500, "Error verifying captcha", [error.message]);
  }
});
