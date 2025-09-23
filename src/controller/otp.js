import nodemailer from "nodemailer";
import 'dotenv/config';

const transporter = nodemailer.createTransport({
  host: "smtp.gmail.com", 
  port: 587,
  secure: false, 
  auth: {
    user: process.env.MAILER_MAIL ,
    pass: process.env.MAILER_PASSWORD ,
  },
});

const otpStorage = new Map();


const generateOTP = () => {
  return Math.floor(100000 + Math.random() * 900000).toString();
};


export const sendOtp = async (req, res) => {
  try {
    const { email } = req.body;


    if (!email) {
      return res.status(400).json({
        success: false,
        message: "Email is required",
      });
    }


    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({
        success: false,
        message: "Please provide a valid email address",
      });
    }


    const otp = generateOTP();
    const expiryTime = Date.now() + 10 * 60 * 1000; // 10 minutes from now

    otpStorage.set(email, {
      otp: otp,
      expiresAt: expiryTime,
      attempts: 0,
      lastSent: Date.now(),
    });


    const mailOptions = {
      from: process.env.EMAIL_USER,
      to: email,
      subject: "Order Confirmation - OTP Verification",
      html: `
       <!DOCTYPE html>
<html>
  <!DOCTYPE html>
<html>
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Order Confirmation - OTP Verification</title>

    <!-- Brand Fonts -->
    <link href="https://fonts.googleapis.com/css2?family=Trirong:wght@400;600&family=Amiko:wght@400;600&family=Khula:wght@400;700&display=swap" rel="stylesheet">

    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      body { 
        font-family: 'Amiko', 'Khula', 'Trirong', sans-serif; 
        line-height: 1.6; 
        color: #333; 
        background-color: #f5f5f5; 
      }
      .wrapper { width: 100%; table-layout: fixed; background-color: #f5f5f5; padding: 40px 0; }
      .container { max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 10px; overflow: hidden; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
      
      .header { background: #0e540b; color: white; padding: 40px 30px; text-align: center; font-family: 'Trirong', serif; }
      .header h1 { font-size: 26px; margin-bottom: 10px; font-weight: 600; }
      .header p { font-size: 15px; opacity: 0.95; font-family: 'Khula', sans-serif; }
      
      .content { padding: 40px 30px; font-family: 'Amiko', sans-serif; }
      .greeting { font-size: 18px; margin-bottom: 15px; color: #0e540b; font-weight: bold; font-family: 'Trirong', serif; }
      .message { font-size: 16px; color: #555; margin-bottom: 25px; line-height: 1.7; font-family: 'Amiko', sans-serif; }
      
      .otp-container { background: #0e540b; padding: 25px; border-radius: 10px; text-align: center; margin: 30px 0; font-family: 'Khula', sans-serif; }
      .otp-label { color: white; font-size: 14px; margin-bottom: 10px; opacity: 0.95; }
      .otp-code { font-size: 36px; font-weight: bold; color: white; letter-spacing: 8px; font-family: 'Courier New', monospace; }
      
      .timer { text-align: center; margin: 20px 0; padding: 15px; background-color: #e8f5e9; border: 1px solid #c8e6c9; border-radius: 5px; color: #0e540b; font-family: 'Khula', sans-serif; }
      
      .security-notice { background-color: #f8f9fa; border-left: 4px solid #0e540b; padding: 15px; margin: 25px 0; border-radius: 0 5px 5px 0; font-family: 'Amiko', sans-serif; }
      .security-notice h3 { color: #0e540b; font-size: 15px; margin-bottom: 8px; font-family: 'Trirong', serif; }
      .security-notice p { font-size: 14px; color: #6c757d; line-height: 1.6; font-family: 'Amiko', sans-serif; }
      
      .footer { background-color: #f8f9fa; padding: 30px; text-align: center; border-top: 1px solid #e9ecef; font-family: 'Khula', sans-serif; }
      .footer p { font-size: 13px; color: #6c757d; margin-bottom: 8px; }
      
      @media screen and (max-width: 600px) {
        .container { margin: 0 10px; }
        .content { padding: 30px 20px; }
        .otp-code { font-size: 28px; letter-spacing: 5px; }
      }
    </style>
  </head>
  <body>
    <div class="wrapper">
      <div class="container">
        <!-- HEADER -->
        <div class="header">
          <h1>✅ Confirm Your Order</h1>
          <p>Use the OTP below to verify your order</p>
        </div>

        <!-- CONTENT -->
        <div class="content">
          <p class="greeting">Hello Customer,</p>
          <p class="message">
            Thank you for shopping with us! To confirm your order securely, please enter the OTP below on the verification page:
          </p>
          
          <!-- OTP BOX -->
          <div class="otp-container">
            <p class="otp-label">Your Order Verification Code</p>
            <div class="otp-code">${otp}</div>
          </div>
          
          <!-- TIMER -->
          <div class="timer">
            ⏱️ <strong>This OTP will expire in 10 minutes</strong>
          </div>
          
          <p class="message">
            If you didn’t place this order, please ignore this email or contact our support team immediately.
          </p>

          <!-- SECURITY NOTICE -->
          <div class="security-notice">
            <h3>🔒 Security Tips</h3>
            <p>
              • Never share this code with anyone<br>
              • Our team will never ask for your OTP<br>
              • This OTP can only be used once<br>
              • Contact support if you notice suspicious activity
            </p>
          </div>
        </div>

        <!-- FOOTER -->
        <div class="footer">
          <p>This is an automated message, please do not reply.</p>
          <p>For help, contact us at support@yourcompany.com</p>
          <p style="margin-top: 15px; font-size: 12px;">
            © ${new Date().getFullYear()} Your Company. All rights reserved.
          </p>
        </div>
      </div>
    </div>
  </body>
</html>
`,
    };

    // Send email
    await transporter.sendMail(mailOptions);

    res.status(200).json({
      success: true,
      message: "OTP sent successfully to your email",
      expiresIn: "10 minutes",
    });
  } catch (error) {
    console.error("Send OTP Error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to send OTP. Please try again later.",
    });
  }
};

// Verify OTP Controller
export const verifyOtp = async (req, res) => {
  try {
    const { email, otp } = req.body;

    // Validate required fields
    if (!email || !otp) {
      return res.status(400).json({
        success: false,
        message: "Email and OTP are required",
      });
    }

    // Check if OTP exists for this email
    const storedOtpData = otpStorage.get(email);
    if (!storedOtpData) {
      return res.status(400).json({
        success: false,
        message: "OTP not found. Please request a new OTP.",
      });
    }

    // Check if OTP has expired
    if (Date.now() > storedOtpData.expiresAt) {
      otpStorage.delete(email);
      return res.status(400).json({
        success: false,
        message: "OTP has expired. Please request a new one.",
      });
    }

    // Check attempt limits (max 3 attempts)
    if (storedOtpData.attempts >= 3) {
      otpStorage.delete(email);
      return res.status(429).json({
        success: false,
        message: "Too many failed attempts. Please request a new OTP.",
      });
    }

    // Verify OTP
    if (storedOtpData.otp !== otp.toString()) {
      // Increment failed attempts
      storedOtpData.attempts += 1;
      otpStorage.set(email, storedOtpData);

      return res.status(400).json({
        success: false,
        message: `Invalid OTP. ${3 - storedOtpData.attempts} attempts remaining.`,
      });
    }

    // OTP is valid - remove from storage
    otpStorage.delete(email);

    res.status(200).json({
      success: true,
      message: "OTP verified successfully",
      email: email,
    });
  } catch (error) {
    console.error("Verify OTP Error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to verify OTP. Please try again later.",
    });
  }
};

// Resend OTP Controller
export const resendOtp = async (req, res) => {
  try {
    const { email } = req.body;

    // Validate email
    if (!email) {
      return res.status(400).json({
        success: false,
        message: "Email is required",
      });
    }

    // Check if there's an existing OTP
    const existingOtpData = otpStorage.get(email);

    // Rate limiting - prevent spam (allow resend only after 1 minute)
    if (existingOtpData && existingOtpData.lastSent) {
      const timeSinceLastSent = Date.now() - existingOtpData.lastSent;
      const minimumWaitTime = 60 * 1000; // 1 minute

      if (timeSinceLastSent < minimumWaitTime) {
        const waitTimeRemaining = Math.ceil(
          (minimumWaitTime - timeSinceLastSent) / 1000
        );
        return res.status(429).json({
          success: false,
          message: `Please wait ${waitTimeRemaining} seconds before requesting another OTP`,
        });
      }
    }

    // Generate new OTP
    const otp = generateOTP();
    const expiryTime = Date.now() + 10 * 60 * 1000; // 10 minutes from now

    // Store new OTP
    otpStorage.set(email, {
      otp: otp,
      expiresAt: expiryTime,
      attempts: 0,
      lastSent: Date.now(),
    });

    // Email content
    const mailOptions = {
      from: process.env.EMAIL_USER,
      to: email,
      subject: "Resend OTP - Order Verification",
      html: `
        <!DOCTYPE html>
<html>
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Resend OTP - Order Verification</title>
    <link href="https://fonts.googleapis.com/css2?family=Trirong:wght@500;700&family=Amiko:wght@400;600&family=Khula:wght@400;600&display=swap" rel="stylesheet">
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      body { font-family: 'Amiko', Arial, sans-serif; line-height: 1.6; color: #333; background-color: #f5f5f5; }
      .wrapper { width: 100%; table-layout: fixed; background-color: #f5f5f5; padding: 40px 0; }
      .container { max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 10px; overflow: hidden; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
      
      .header { background: #0e540b; color: white; padding: 40px 30px; text-align: center; }
      .header h1 { font-family: 'Trirong', serif; font-size: 26px; margin-bottom: 10px; }
      .header p { font-family: 'Khula', sans-serif; font-size: 15px; opacity: 0.95; }
      
      .content { padding: 40px 30px; }
      .greeting { font-family: 'Trirong', serif; font-size: 18px; margin-bottom: 15px; color: #0e540b; font-weight: bold; }
      .message { font-family: 'Amiko', sans-serif; font-size: 16px; color: #555; margin-bottom: 25px; line-height: 1.7; }
      
      .otp-container { background: #0e540b; padding: 25px; border-radius: 10px; text-align: center; margin: 30px 0; }
      .otp-label { font-family: 'Khula', sans-serif; color: white; font-size: 14px; margin-bottom: 10px; opacity: 0.95; }
      .otp-code { font-family: 'Courier New', monospace; font-size: 36px; font-weight: bold; color: white; letter-spacing: 8px; }
      
      .timer { text-align: center; margin: 20px 0; padding: 15px; background-color: #e8f5e9; border: 1px solid #c8e6c9; border-radius: 5px; color: #0e540b; font-family: 'Khula', sans-serif; }
      
      .security-notice { background-color: #f8f9fa; border-left: 4px solid #0e540b; padding: 15px; margin: 25px 0; border-radius: 0 5px 5px 0; }
      .security-notice h3 { font-family: 'Trirong', serif; color: #0e540b; font-size: 15px; margin-bottom: 8px; }
      .security-notice p { font-family: 'Amiko', sans-serif; font-size: 14px; color: #6c757d; line-height: 1.6; }
      
      .footer { background-color: #f8f9fa; padding: 30px; text-align: center; border-top: 1px solid #e9ecef; }
      .footer p { font-family: 'Khula', sans-serif; font-size: 13px; color: #6c757d; margin-bottom: 8px; }
      
      @media screen and (max-width: 600px) {
        .container { margin: 0 10px; }
        .content { padding: 30px 20px; }
        .otp-code { font-size: 28px; letter-spacing: 5px; }
      }
    </style>
  </head>
  <body>
    <div class="wrapper">
      <div class="container">
        <!-- HEADER -->
        <div class="header">
          <h1>🔄 Resend OTP</h1>
          <p>Your new verification code has been generated</p>
        </div>

        <!-- CONTENT -->
        <div class="content">
          <p class="greeting">Hello Customer,</p>
          <p class="message">
            You requested a new OTP for confirming your order. Please use the latest OTP below and enter it on the verification page:
          </p>
          
          <!-- OTP BOX -->
          <div class="otp-container">
            <p class="otp-label">Your New Verification Code</p>
            <div class="otp-code">${otp}</div>
          </div>
          
          <!-- TIMER -->
          <div class="timer">
            ⏱️ <strong>This OTP will expire in 10 minutes</strong>
          </div>
          
          <p class="message">
            If you did not request this new OTP, you can safely ignore this email. Your account and order remain secure.
          </p>

          <!-- SECURITY NOTICE -->
          <div class="security-notice">
            <h3>🔒 Security Tips</h3>
            <p>
              • Use only the latest OTP you receive<br>
              • Do not share this code with anyone<br>
              • Our team will never ask for your OTP<br>
              • Contact support if you notice suspicious activity
            </p>
          </div>
        </div>

        <!-- FOOTER -->
        <div class="footer">
          <p>This is an automated message, please do not reply.</p>
          <p>Need help? Contact us at support@yourcompany.com</p>
          <p style="margin-top: 15px; font-size: 12px;">
            © ${new Date().getFullYear()} Your Company. All rights reserved.
          </p>
        </div>
      </div>
    </div>
  </body>
</html>
      `,
    };

    // Send email
    await transporter.sendMail(mailOptions);

    res.status(200).json({
      success: true,
      message: "New OTP sent successfully to your email",
      expiresIn: "10 minutes",
    });
  } catch (error) {
    console.error("Resend OTP Error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to resend OTP. Please try again later.",
    });
  }
};
