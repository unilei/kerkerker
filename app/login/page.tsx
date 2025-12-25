"use client";

import { useState, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const redirect = searchParams.get("redirect") || "/admin/settings";

  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ password }),
      });

      const data = await res.json();

      if (res.ok) {
        router.push(redirect);
        router.refresh();
      } else {
        setError(data.error || "登录失败");
      }
    } catch (err) {
      console.error("Login error:", err);
      setError("登录失败，请重试");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#141414]">
      <div className="w-full max-w-md px-6">
        <div className="bg-[#1a1a1a] rounded-lg shadow-2xl p-10 border border-[#333]">
          {/* Netflix Logo Style */}
          <div className="text-center mb-8">
            <h1 className="text-4xl font-bold text-[#E50914] mb-2">壳儿</h1>
            <p className="text-[#808080] text-lg">后台管理系统</p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-6">
            <div>
              <label
                htmlFor="password"
                className="block text-sm font-medium text-[#b3b3b3] mb-2"
              >
                密码
              </label>
              <input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full px-4 py-3 bg-[#333] border border-[#454545] rounded text-white placeholder-[#8c8c8c] focus:outline-none focus:ring-2 focus:ring-[#E50914] focus:border-transparent transition"
                placeholder="请输入管理员密码"
                required
                autoFocus
              />
            </div>

            {error && (
              <div className="bg-[#E50914]/10 border border-[#E50914]/50 rounded p-3 text-[#E50914] text-sm">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full bg-[#E50914] hover:bg-[#B20710] disabled:bg-[#831010] disabled:cursor-not-allowed text-white font-bold py-3 px-4 rounded transition duration-200"
            >
              {loading ? "登录中..." : "登录"}
            </button>
          </form>

          <div className="mt-8 text-center text-sm text-[#8c8c8c]">
            <p>默认密码：admin123</p>
            <p className="mt-1">可通过环境变量 ADMIN_PASSWORD 修改</p>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center bg-[#141414]">
          <div className="text-white">加载中...</div>
        </div>
      }
    >
      <LoginForm />
    </Suspense>
  );
}
