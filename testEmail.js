import mongoose from "mongoose";
import crypto from "crypto";
import {
  sendPasswordResetEmail,
  sendEmailVerification,
  sendWelcomeEmail,
  verifyEmailConfig,
} from "./src/utility/emailService.js";
import User from "./src/Model/user.js";
import "dotenv/config";

// Hash token function (same as controller)
const hashToken = (token) => {
  return crypto.createHash("sha256").update(token).digest("hex");
};

async function connectDB() {
  try {
    await mongoose.connect(process.env.DB_URI);
    console.log("✅ Connected to MongoDB\n");
  } catch (error) {
    console.error("❌ MongoDB connection failed:", error.message);
    process.exit(1);
  }
}

async function testEmailService() {
  console.log("🧪 Complete Email Service Test with Real Users\n");
  console.log("=".repeat(60));

  // Connect to database
  await connectDB();

  // Step 1: Verify email configuration
  console.log("\n📋 Step 1: Verifying email configuration...");
  const isConfigured = await verifyEmailConfig();

  if (!isConfigured) {
    console.error("❌ Email service is not properly configured");
    console.log("\n⚠️  Configuration Check:");
    console.log("   EMAIL_HOST:", process.env.EMAIL_HOST || "NOT SET");
    console.log("   EMAIL_PORT:", process.env.EMAIL_PORT || "NOT SET");
    console.log("   EMAIL_USER:", process.env.EMAIL_USER || "NOT SET");
    console.log("   EMAIL_PASS:", process.env.EMAIL_PASS ? "✓ SET" : "❌ NOT SET");
    console.log("\n📖 Setup Guide:");
    console.log("   1. Go to https://myaccount.google.com/apppasswords");
    console.log("   2. Generate a new app password");
    console.log("   3. Add it to .env as EMAIL_PASS=your-16-char-password");
    await mongoose.disconnect();
    return;
  }

  console.log("✅ Email configuration verified!");

  // Get test email from command line or prompt for user email
  let testEmail = process.argv[2];

  if (!testEmail) {
    console.log("\n📧 No email provided in command line");
    console.log("   Usage: npm run test-email user@example.com");
    console.log("\n   Searching for a test user in database...");

    // Try to find a user in database
    const testUser = await User.findOne({ role: "user" }).limit(1);
    if (testUser) {
      testEmail = testUser.email;
      console.log(`   ✓ Found test user: ${testEmail}`);
    } else {
      testEmail = process.env.EMAIL_USER;
      console.log(`   ℹ Using configured email: ${testEmail}`);
    }
  }

  console.log("\n" + "=".repeat(60));
  console.log(`\n🎯 Testing with email: ${testEmail}\n`);

  // =================================================================
  // Test 1: Password Reset with Real Token
  // =================================================================
  console.log("─".repeat(60));
  console.log("📝 Test 1: Password Reset Flow (With Real Token)");
  console.log("─".repeat(60));

  try {
    // Find or create test user
    let user = await User.findOne({ email: testEmail });

    if (!user) {
      console.log("   ⚠️  User not found, creating test user...");
      user = await User.create({
        username: "Test User",
        email: testEmail,
        password: "testpassword123",
        role: "user",
        isActive: true,
        isApproved: true,
        isEmailVerified: true,
      });
      console.log("   ✓ Test user created");
    }

    // Generate real reset token (same as controller)
    const resetToken = crypto.randomBytes(32).toString("hex");
    const hashedResetToken = hashToken(resetToken);

    // Save to database
    user.passwordResetToken = hashedResetToken;
    user.passwordResetExpires = Date.now() + 60 * 60 * 1000; // 1 hour
    await user.save();

    const resetUrl = `${process.env.FRONTEND_URL}/reset-password/${resetToken}`;

    console.log("\n   📊 Token Details:");
    console.log(`   • Raw Token: ${resetToken.substring(0, 20)}...`);
    console.log(`   • Hashed Token: ${hashedResetToken.substring(0, 20)}...`);
    console.log(`   • Reset URL: ${resetUrl}`);
    console.log(`   • Expires: ${new Date(user.passwordResetExpires).toLocaleString()}`);

    // Send email
    console.log("\n   📤 Sending password reset email...");
    await sendPasswordResetEmail(user.email, user.username, resetUrl);
    console.log("   ✅ Password reset email sent successfully!");
    console.log(`   📬 Check inbox: ${testEmail}`);

    // Verify token is in database
    const verifyUser = await User.findOne({
      email: testEmail,
      passwordResetToken: hashedResetToken,
    });
    console.log(`   ✓ Token verified in database: ${verifyUser ? "YES" : "NO"}`);

  } catch (error) {
    console.error("   ❌ Failed:", error.message);
  }

  // =================================================================
  // Test 2: Admin Email Verification with Real Token
  // =================================================================
  console.log("\n" + "─".repeat(60));
  console.log("📝 Test 2: Admin Email Verification Flow (With Real Token)");
  console.log("─".repeat(60));

  try {
    // Find or create admin user
    const adminEmail = `admin_${testEmail}`;
    let admin = await User.findOne({ email: adminEmail, role: "admin" });

    if (!admin) {
      console.log("   ⚠️  Admin not found, creating test admin...");
      
      // Generate verification token
      const emailVerificationToken = crypto.randomBytes(32).toString("hex");
      const hashedEmailToken = hashToken(emailVerificationToken);

      admin = await User.create({
        username: "Test Admin",
        email: adminEmail,
        password: "adminpassword123",
        role: "admin",
        isActive: true,
        isApproved: true,
        isEmailVerified: false,
        emailVerificationToken: hashedEmailToken,
        emailVerificationExpires: Date.now() + 24 * 60 * 60 * 1000,
      });
      console.log("   ✓ Test admin created");
    } else if (admin.isEmailVerified) {
      // Reset verification status for testing
      const emailVerificationToken = crypto.randomBytes(32).toString("hex");
      const hashedEmailToken = hashToken(emailVerificationToken);
      
      admin.isEmailVerified = false;
      admin.emailVerificationToken = hashedEmailToken;
      admin.emailVerificationExpires = Date.now() + 24 * 60 * 60 * 1000;
      await admin.save();
      console.log("   ℹ Reset admin verification status for testing");
    }

    // Generate new verification token
    const verificationToken = crypto.randomBytes(32).toString("hex");
    const hashedVerificationToken = hashToken(verificationToken);

    admin.emailVerificationToken = hashedVerificationToken;
    admin.emailVerificationExpires = Date.now() + 24 * 60 * 60 * 1000;
    await admin.save();

    const verificationUrl = `${process.env.FRONTEND_URL}/admin/verify-email/${verificationToken}`;

    console.log("\n   📊 Verification Details:");
    console.log(`   • Email: ${adminEmail}`);
    console.log(`   • Raw Token: ${verificationToken.substring(0, 20)}...`);
    console.log(`   • Hashed Token: ${hashedVerificationToken.substring(0, 20)}...`);
    console.log(`   • Verification URL: ${verificationUrl}`);
    console.log(`   • Expires: ${new Date(admin.emailVerificationExpires).toLocaleString()}`);

    // Send email
    console.log("\n   📤 Sending verification email...");
    await sendEmailVerification(admin.email, admin.username, verificationUrl);
    console.log("   ✅ Verification email sent successfully!");
    console.log(`   📬 Check inbox: ${adminEmail}`);

    // Verify token is in database
    const verifyAdmin = await User.findOne({
      email: adminEmail,
      emailVerificationToken: hashedVerificationToken,
    });
    console.log(`   ✓ Token verified in database: ${verifyAdmin ? "YES" : "NO"}`);

  } catch (error) {
    console.error("   ❌ Failed:", error.message);
  }

  // =================================================================
  // Test 3: Welcome Email
  // =================================================================
  console.log("\n" + "─".repeat(60));
  console.log("📝 Test 3: Welcome Email (New User Registration)");
  console.log("─".repeat(60));

  try {
    const user = await User.findOne({ email: testEmail });

    console.log("\n   📊 User Details:");
    console.log(`   • Username: ${user.username}`);
    console.log(`   • Email: ${user.email}`);
    console.log(`   • Role: ${user.role}`);
    console.log(`   • Created: ${user.createdAt?.toLocaleString() || "N/A"}`);

    console.log("\n   📤 Sending welcome email...");
    await sendWelcomeEmail(user.email, user.username);
    console.log("   ✅ Welcome email sent successfully!");
    console.log(`   📬 Check inbox: ${testEmail}`);

  } catch (error) {
    console.error("   ❌ Failed:", error.message);
  }

  // =================================================================
  // Summary
  // =================================================================
  console.log("\n" + "=".repeat(60));
  console.log("🎉 Email Testing Complete!");
  console.log("=".repeat(60));
  console.log("\n📋 Summary:");
  console.log(`   • Test Email: ${testEmail}`);
  console.log(`   • Admin Email: admin_${testEmail}`);
  console.log(`   • Frontend URL: ${process.env.FRONTEND_URL}`);
  console.log("\n📬 Next Steps:");
  console.log("   1. Check your email inbox (and spam folder)");
  console.log("   2. Click the links in the emails to test the flows");
  console.log("   3. Verify tokens work with your frontend");
  console.log("\n💡 Test URLs Generated:");
  console.log(`   • Password Reset: ${process.env.FRONTEND_URL}/reset-password/[token]`);
  console.log(`   • Email Verification: ${process.env.FRONTEND_URL}/admin/verify-email/[token]`);
  console.log("\n🔍 Database Check:");
  
  const dbUser = await User.findOne({ email: testEmail }).select(
    "email username passwordResetToken passwordResetExpires"
  );
  const dbAdmin = await User.findOne({ 
    email: `admin_${testEmail}`, 
    role: "admin" 
  }).select("email username emailVerificationToken emailVerificationExpires isEmailVerified");

  if (dbUser) {
    console.log(`   ✓ User found: ${dbUser.email}`);
    console.log(`     - Has reset token: ${dbUser.passwordResetToken ? "YES" : "NO"}`);
    if (dbUser.passwordResetExpires) {
      console.log(`     - Token expires: ${new Date(dbUser.passwordResetExpires).toLocaleString()}`);
    }
  }

  if (dbAdmin) {
    console.log(`   ✓ Admin found: ${dbAdmin.email}`);
    console.log(`     - Has verification token: ${dbAdmin.emailVerificationToken ? "YES" : "NO"}`);
    console.log(`     - Email verified: ${dbAdmin.isEmailVerified ? "YES" : "NO"}`);
    if (dbAdmin.emailVerificationExpires) {
      console.log(`     - Token expires: ${new Date(dbAdmin.emailVerificationExpires).toLocaleString()}`);
    }
  }

  console.log("\n" + "=".repeat(60) + "\n");

  // Disconnect from database
  await mongoose.disconnect();
  console.log("✅ Disconnected from MongoDB\n");
}

// Run the test
testEmailService()
  .then(() => {
    console.log("✨ Test completed successfully!");
    process.exit(0);
  })
  .catch((error) => {
    console.error("\n💥 Test failed with error:");
    console.error(error);
    process.exit(1);
  });