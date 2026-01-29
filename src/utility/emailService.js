import { createTransport } from "nodemailer";
import "dotenv/config";

// Create reusable transporter
const createEmailTransporter = () => {
  return createTransport({
    host: "smtp.gmail.com",
    port: 587,
    secure: false,
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS,
    },
    pool: true,
    maxConnections: 5,
    maxMessages: 100,
  });
};

// Email templates
const getEmailTemplate = (type, data) => {
  console.log(type, data);
  const templates = {
    passwordReset: {
      subject: "Password Reset Request - VegBazar",
      html: `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <link rel="preconnect" href="https://fonts.googleapis.com">
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
        <link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700&display=swap" rel="stylesheet">
      </head>
      <body style="font-family: 'Poppins', -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif; margin: 0; padding: 0; background-color: #f3f4f6;">
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: #f3f4f6; padding: 40px 20px;">
          <tr>
            <td align="center">
              <table width="600" cellpadding="0" cellspacing="0" border="0" style="max-width: 600px; background-color: #ffffff; border-radius: 8px; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1); overflow: hidden;">
                <!-- Header -->
                <tr>
                  <td style="background-color: #0e540b; color: #ffffff; text-align: center; padding: 32px 24px;">
                    <h1 style="font-size: 24px; font-weight: 600; margin: 0; color: #ffffff;">Password Reset</h1>
                  </td>
                </tr>
                
                <!-- Content -->
                <tr>
                  <td style="padding: 32px;">
                    <p style="font-size: 15px; color: #374151; margin: 0 0 16px 0; line-height: 1.6;">Hello ${data.username || "User"},</p>
                    <p style="font-size: 15px; color: #374151; margin: 0 0 16px 0; line-height: 1.6;">We received a request to reset your password. Click the button below to create a new password:</p>
                    
                    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin: 24px 0;">
                      <tr>
                        <td align="center">
                          <a href="${data.resetUrl}" style="display: inline-block; background-color: #e24100; color: #ffffff; text-decoration: none; font-weight: 600; font-size: 15px; padding: 12px 32px; border-radius: 4px;">Reset Password</a>
                        </td>
                      </tr>
                    </table>
                    
                    </table>
                    
                    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin: 20px 0;">
                      <tr>
                        <td style="background-color: #fef3c7; border-left: 4px solid #fbbf24; padding: 16px; font-size: 14px; color: #92400e;">
                          <p style="font-weight: bold; margin: 0 0 8px 0;">Security Notice:</p>
                          <ul style="margin: 8px 0 0 20px; padding: 0;">
                            <li style="margin: 8px 0;">This link expires in 1 hour</li>
                            <li style="margin: 8px 0;">If you didn't request this, please ignore this email</li>
                            <li style="margin: 8px 0;">Never share this token with anyone</li>
                          </ul>
                        </td>
                      </tr>
                    </table>
                    
                    <p style="font-size: 15px; color: #374151; margin: 20px 0 0 0; line-height: 1.6;">Need assistance? Contact us at <a href="mailto:info.vegbazar@gmail.com" style="color: #ff6b35; text-decoration: none;">info.vegbazar@gmail.com</a></p>
                  </td>
                </tr>
                
                <!-- Footer -->
                <tr>
                  <td style="background-color: #f9fafb; text-align: center; padding: 20px 24px;">
                    <p style="color: #6b7280; font-size: 13px; margin: 0;">&copy; ${new Date().getFullYear()} VegBazar. All rights reserved.</p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </body>
      </html>
    `,
      text: `VegBazar - Password Reset Request

Hello ${data.username || "User"},

We received a request to reset your password for your VegBazar account.

Reset Token: ${data.token}

Or visit: ${data.resetUrl}

Security Notice:
- This link expires in 1 hour
- If you didn't request this, please ignore this email
- Never share this token with anyone

Need assistance? Contact us at info.vegbazar@gmail.com

Best regards,
VegBazar Team

© ${new Date().getFullYear()} VegBazar. All rights reserved.
    `,
    },

    emailVerification: {
      subject: "Verify Your Email - VegBazar",
      html: `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <link rel="preconnect" href="https://fonts.googleapis.com">
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
        <link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700&display=swap" rel="stylesheet">
      </head>
      <body style="font-family: 'Poppins', -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif; margin: 0; padding: 0; background-color: #f3f4f6;">
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: #f3f4f6; padding: 40px 20px;">
          <tr>
            <td align="center">
              <table width="600" cellpadding="0" cellspacing="0" border="0" style="max-width: 600px; background-color: #ffffff; border-radius: 8px; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1); overflow: hidden;">
                <!-- Header -->
                <tr>
                  <td style="background-color: #0e540b; color: #ffffff; text-align: center; padding: 32px 24px;">
                    <h1 style="font-size: 24px; font-weight: 600; margin: 0; color: #ffffff;">Email Verification</h1>
                  </td>
                </tr>
                
                <!-- Content -->
                <tr>
                  <td style="padding: 32px;">
                    <p style="font-size: 15px; color: #374151; margin: 0 0 16px 0; line-height: 1.6;">Hello ${data.username},</p>
                    <p style="font-size: 15px; color: #374151; margin: 0 0 16px 0; line-height: 1.6;">Thank you for joining VegBazar. Please verify your email address to activate your account:</p>
                    
                    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin: 24px 0;">
                      <tr>
                        <td align="center">
                          <a href="${data.verificationUrl}" style="display: inline-block; background-color: #e24100; color: #ffffff; text-decoration: none; font-weight: 600; font-size: 15px; padding: 12px 32px; border-radius: 4px;">Verify Email</a>
                        </td>
                      </tr>
                    </table>
                    
                    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin: 20px 0;">
                      <tr>
                        <td style="background-color: #dbeafe; border-left: 4px solid #0e540b; padding: 16px; font-size: 14px;">
                          <p style="margin: 0;"><strong>Important:</strong> This verification link expires in 24 hours.</p>
                        </td>
                      </tr>
                    </table>
                    
                    <p style="font-size: 15px; color: #374151; margin: 0 0 8px 0; line-height: 1.6;">If you're unable to click the button, copy and paste this link into your browser:</p>
                    <p style="word-break: break-all; color: #ff6b35; font-size: 13px; margin: 0;">${data.verificationUrl}</p>
                  </td>
                </tr>
                
                <!-- Footer -->
                <tr>
                  <td style="background-color: #f9fafb; text-align: center; padding: 20px 24px;">
                    <p style="color: #6b7280; font-size: 13px; margin: 0 0 8px 0;">&copy; ${new Date().getFullYear()} VegBazar. All rights reserved.</p>
                    <p style="color: #6b7280; font-size: 13px; margin: 0;">Questions? Contact us at info.vegbazar@gmail.com</p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </body>
      </html>
    `,
      text: `VegBazar - Email Verification

Hello ${data.username},

Thank you for joining VegBazar. Please verify your email address to activate your account.

Verification Link: ${data.verificationUrl}

This verification link expires in 24 hours.

Questions? Contact us at info.vegbazar@gmail.com

Best regards,
VegBazar Team

© ${new Date().getFullYear()} VegBazar. All rights reserved.
    `,
    },

    welcomeEmail: {
      subject: "Welcome to VegBazar",
      html: `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <link rel="preconnect" href="https://fonts.googleapis.com">
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
        <link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700&display=swap" rel="stylesheet">
      </head>
      <body style="font-family: 'Poppins', -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif; margin: 0; padding: 0; background-color: #f3f4f6;">
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: #f3f4f6; padding: 40px 20px;">
          <tr>
            <td align="center">
              <table width="600" cellpadding="0" cellspacing="0" border="0" style="max-width: 600px; background-color: #ffffff; border-radius: 8px; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1); overflow: hidden;">
                <!-- Header -->
                <tr>
                  <td style="background-color: #0e540b; color: #ffffff; text-align: center; padding: 32px 24px;">
                    <h1 style="font-size: 24px; font-weight: 600; margin: 0; color: #ffffff;">Welcome to VegBazar</h1>
                  </td>
                </tr>
                
                <!-- Content -->
                <tr>
                  <td style="padding: 32px;">
                    <p style="font-size: 15px; color: #374151; margin: 0 0 16px 0; line-height: 1.6;">Hello ${data.username},</p>
                    <p style="font-size: 15px; color: #374151; margin: 0 0 16px 0; line-height: 1.6;">Welcome to VegBazar. We're pleased to have you as a customer.</p>
                    
                    <p style="font-size: 15px; color: #1f2937; font-weight: 600; margin: 0 0 12px 0;">Our Services:</p>
                    <ul style="margin: 0 0 24px 20px; padding: 0; color: #374151; font-size: 15px; line-height: 1.8;">
                      <li style="margin: 12px 0;">Farm-fresh vegetables delivered daily</li>
                      <li style="margin: 12px 0;">Same-day delivery for orders before noon</li>
                      <li style="margin: 12px 0;">Competitive pricing with member discounts</li>
                      <li style="margin: 12px 0;">Real-time order tracking</li>
                    </ul>
                    
                    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin: 24px 0;">
                      <tr>
                        <td align="center">
                          <a href="${data.shopUrl || "https://vegbazar.store/"}" style="display: inline-block; background-color: #ff6b35; color: #ffffff; text-decoration: none; font-weight: 600; font-size: 15px; padding: 12px 32px; border-radius: 4px;">Start Shopping</a>
                        </td>
                      </tr>
                    </table>
                    
                    <p style="font-size: 15px; color: #374151; margin: 24px 0 0 0; line-height: 1.6;">If you have any questions, please contact us at <a href="mailto:info.vegbazar@gmail.com" style="color: #ff6b35; text-decoration: none;">info.vegbazar@gmail.com</a></p>
                  </td>
                </tr>
                
                <!-- Footer -->
                <tr>
                  <td style="background-color: #f9fafb; text-align: center; padding: 20px 24px;">
                    <p style="color: #6b7280; font-size: 13px; margin: 0;">&copy; ${new Date().getFullYear()} VegBazar. All rights reserved.</p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </body>
      </html>
    `,
      text: `VegBazar - Welcome

Hello ${data.username},

Welcome to VegBazar. We're pleased to have you as a customer.

Our Services:
- Farm-fresh vegetables delivered daily
- Same-day delivery for orders before noon
- Competitive pricing with member discounts
- Real-time order tracking

Start shopping: ${data.shopUrl || "https://vegbazar.store"}

If you have any questions, contact us at info.vegbazar@gmail.com

Best regards,
VegBazar Team

© ${new Date().getFullYear()} VegBazar. All rights reserved.
    `,
    },
  };
  
  return templates[type] || null;
};

// Main email sending function
export const sendEmail = async (to, type, data) => {
  try {
    const transporter = createEmailTransporter();
    const template = getEmailTemplate(type, data);

    if (!template) {
      throw new Error(`Invalid email template type: ${type}`);
    }

    const mailOptions = {
      from: `"VegBazar" <${process.env.EMAIL_USER}>`,
      to,
      subject: template.subject,
      text: template.text,
      html: template.html,
    };

    const info = await transporter.sendMail(mailOptions);

    console.log(`Email sent successfully to ${to}: ${info.messageId}`);
    return { success: true, messageId: info.messageId };
  } catch (error) {
    console.error("Error sending email:", error);
    throw error;
  }
};

// Specific email functions
export const sendPasswordResetEmail = async (to, username, resetUrl, token) => {
  return sendEmail(to, "passwordReset", { username, resetUrl, token });
};

export const sendEmailVerification = async (to, username, verificationUrl) => {
  return sendEmail(to, "emailVerification", { username, verificationUrl });
};

export const sendWelcomeEmail = async (to, username) => {
  return sendEmail(to, "welcomeEmail", { username });
};

// Verify email configuration
export const verifyEmailConfig = async () => {
  try {
    const transporter = createEmailTransporter();
    await transporter.verify();
    console.log("✅ Email service is ready");
    return true;
  } catch (error) {
    console.error("❌ Email service configuration error:", error);
    return false;
  }
};
