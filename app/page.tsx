import type { Metadata } from "next";
import { SubEthaApp } from "./components/SubEthaApp";

export const metadata: Metadata = {
  title: "Sub-Etha — a calmer Matrix client",
  description: "A fast, private, installable Matrix client for the rest of the galaxy.",
};

export default function Home() {
  return <SubEthaApp />;
}
