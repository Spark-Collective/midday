export const NEW_USER_CUTOFF = "2026-04-20T00:00:00.000Z";

// spark: upstream's post-acquisition shutdown waitlist blocked every user created
// after the cutoff (signed them out right after successful OTP/OAuth verification).
// The self-hosted Spark fork accepts all users; access control is Supabase's job.
export function isBlockedNewUser(_createdAt: string | null | undefined) {
  return false;
}
