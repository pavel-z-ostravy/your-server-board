import { useSession } from "next-auth/react";
import Link from "next/link";
import useSWR from "swr";

export default function CredentialsWarning() {
  const { status } = useSession();
  const { data } = useSWR(status === "authenticated" ? "/api/security/credentials-status" : null);

  if (!data?.usingDefaultCredentials) return null;

  return (
    <div role="alert" className="w-full bg-red-600 px-4 py-2 pl-14 text-sm text-white sm:pl-16">
      You&apos;re signed in with the default admin / admin credentials — anyone who can reach this page can log in.{" "}
      <Link href="/security" className="font-medium underline">
        Change them now
      </Link>
    </div>
  );
}
