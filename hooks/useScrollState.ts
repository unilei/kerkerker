import { useState, useEffect } from "react";

/**
 * 监听页面滚动状态
 * @param threshold 触发滚动状态的阈值（默认 50px）
 * @returns 是否已滚动超过阈值
 */
export function useScrollState(threshold = 50): boolean {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const handleScroll = () => {
      setScrolled(window.scrollY > threshold);
    };
    
    window.addEventListener("scroll", handleScroll);
    return () => window.removeEventListener("scroll", handleScroll);
  }, [threshold]);

  return scrolled;
}
