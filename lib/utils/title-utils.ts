/**
 * 标题清理工具
 * 用于从豆瓣等来源的完整标题中提取用于搜索的简短标题
 */

// 常见的豆瓣标题格式：
// 1. "罗小黑战记2‎ (2025)" - 中文 + 年份
// 2. "人偶之家 ドールハウス‎ (2025)" - 中文 + 日文 + 年份
// 3. "Inception (2010)" - 纯英文 + 年份
// 4. "阿凡达 Avatar (2009)" - 中文 + 英文 + 年份
// 5. "寄生虫 기생충 (2019)" - 中文 + 韩文 + 年份
// 6. "复仇者联盟4：终局之战 (2019)" - 中文带副标题
// 7. "Spider-Man: No Way Home (2021)" - 英文带副标题

/**
 * 检测字符类型
 */
function getCharType(char: string): 'chinese' | 'japanese' | 'korean' | 'english' | 'number' | 'symbol' | 'space' {
  const code = char.charCodeAt(0);
  
  // 中文字符范围
  if (code >= 0x4E00 && code <= 0x9FFF) return 'chinese';
  if (code >= 0x3400 && code <= 0x4DBF) return 'chinese'; // 扩展A
  
  // 日文字符范围（平假名、片假名）
  if (code >= 0x3040 && code <= 0x309F) return 'japanese'; // 平假名
  if (code >= 0x30A0 && code <= 0x30FF) return 'japanese'; // 片假名
  
  // 韩文字符范围
  if (code >= 0xAC00 && code <= 0xD7AF) return 'korean';
  if (code >= 0x1100 && code <= 0x11FF) return 'korean';
  
  // 英文字符
  if ((code >= 0x41 && code <= 0x5A) || (code >= 0x61 && code <= 0x7A)) return 'english';
  
  // 数字
  if (code >= 0x30 && code <= 0x39) return 'number';
  
  // 空格
  if (char === ' ' || char === '\u3000') return 'space';
  
  return 'symbol';
}

/**
 * 分析标题的语言组成
 */
function analyzeTitle(title: string): {
  hasChinese: boolean;
  hasJapanese: boolean;
  hasKorean: boolean;
  hasEnglish: boolean;
  primaryLanguage: 'chinese' | 'japanese' | 'korean' | 'english' | 'mixed';
} {
  let chineseCount = 0;
  let japaneseCount = 0;
  let koreanCount = 0;
  let englishCount = 0;
  
  for (const char of title) {
    const type = getCharType(char);
    if (type === 'chinese') chineseCount++;
    else if (type === 'japanese') japaneseCount++;
    else if (type === 'korean') koreanCount++;
    else if (type === 'english') englishCount++;
  }
  
  let primaryLanguage: 'chinese' | 'japanese' | 'korean' | 'english' | 'mixed' = 'mixed';
  const max = Math.max(chineseCount, japaneseCount, koreanCount, englishCount);
  
  if (max > 0) {
    if (chineseCount === max) primaryLanguage = 'chinese';
    else if (japaneseCount === max) primaryLanguage = 'japanese';
    else if (koreanCount === max) primaryLanguage = 'korean';
    else if (englishCount === max) primaryLanguage = 'english';
  }
  
  return {
    hasChinese: chineseCount > 0,
    hasJapanese: japaneseCount > 0,
    hasKorean: koreanCount > 0,
    hasEnglish: englishCount > 0,
    primaryLanguage,
  };
}

/**
 * 提取第一个中文标题部分
 * 注意：日文汉字和中文共享相同的Unicode范围，需要通过空格分隔来区分
 */
function extractChinese(title: string): string {
  // 按空格分割标题，取第一个包含中文的部分
  const parts = title.split(/\s+/);
  
  for (const part of parts) {
    // 检查这个部分是否主要是中文（不包含日文假名）
    const hasHiragana = /[\u3040-\u309F]/.test(part);
    const hasKatakana = /[\u30A0-\u30FF]/.test(part);
    const hasChinese = /[\u4E00-\u9FFF]/.test(part);
    
    // 如果包含假名，说明是日文，跳过
    if (hasHiragana || hasKatakana) continue;
    
    // 如果是纯中文（可能带数字），返回
    if (hasChinese && part.length >= 2) {
      return part;
    }
  }
  
  // 如果没找到纯中文部分，返回第一个包含汉字的部分
  for (const part of parts) {
    if (/[\u4E00-\u9FFF]/.test(part) && part.length >= 2) {
      return part;
    }
  }
  
  return '';
}

/**
 * 提取英文部分（包括数字）
 */
function extractEnglish(title: string): string {
  // 匹配英文单词、数字和常见连接符
  const matches = title.match(/[A-Za-z][A-Za-z0-9\s:\-']+/g);
  if (!matches) return '';
  
  // 返回最长的英文片段（通常是主标题）
  return matches.reduce((a, b) => a.length > b.length ? a : b, '').trim();
}

/**
 * 清理标题用于搜索
 * 
 * @param title 原始标题
 * @param options 选项
 * @returns 清理后的标题
 */
export function cleanTitleForSearch(
  title: string,
  options: {
    preferChinese?: boolean;  // 优先返回中文（默认true）
    keepNumbers?: boolean;    // 保留数字（如续集编号，默认true）
    keepSubtitle?: boolean;   // 保留副标题（默认false）
  } = {}
): string {
  const { preferChinese = true, keepNumbers = true, keepSubtitle = false } = options;
  
  if (!title) return '';
  
  // 1. 移除Unicode控制字符和特殊标记
  let cleaned = title.replace(/[\u200B-\u200F\u2028-\u202F\uFEFF]/g, '');
  
  // 2. 移除年份 (2025)、（2025）等
  cleaned = cleaned.replace(/\s*[\(（]\d{4}[\)）]\s*/g, '');
  
  // 3. 分析标题语言组成
  const analysis = analyzeTitle(cleaned);
  
  let result = '';
  
  if (preferChinese && analysis.hasChinese) {
    // 优先提取中文
    result = extractChinese(cleaned);
    
    // 如果中文部分太短（可能只是数字或符号），尝试其他方案
    if (result.length < 2) {
      result = cleaned;
    }
  } else if (analysis.hasEnglish) {
    // 提取英文
    result = extractEnglish(cleaned);
  } else if (analysis.hasJapanese || analysis.hasKorean) {
    // 日韩标题，保留原样（移除年份后）
    result = cleaned;
  } else {
    result = cleaned;
  }
  
  // 4. 处理副标题（冒号、破折号分隔）
  if (!keepSubtitle) {
    // 移除副标题（冒号、破折号后的内容）
    // 但要小心处理，有些标题本身包含这些符号
    const subtitleMatch = result.match(/^([^：:—\-]+)[：:—\-]/);
    if (subtitleMatch && subtitleMatch[1].length >= 2) {
      result = subtitleMatch[1];
    }
  }
  
  // 5. 处理数字
  if (!keepNumbers) {
    // 移除标题末尾的数字（如续集编号）
    result = result.replace(/\d+$/g, '');
  }
  
  // 6. 清理多余空格和符号
  result = result
    .replace(/\s+/g, ' ')  // 多个空格合并
    .replace(/^[\s：:·\-—]+|[\s：:·\-—]+$/g, '')  // 移除首尾符号
    .trim();
  
  return result || title;
}

/**
 * 生成多个搜索关键词变体
 * 用于提高搜索匹配率
 */
export function generateSearchVariants(title: string): string[] {
  const variants: string[] = [];
  
  // 清理后的主标题
  const mainTitle = cleanTitleForSearch(title);
  if (mainTitle) variants.push(mainTitle);
  
  // 带副标题的版本
  const withSubtitle = cleanTitleForSearch(title, { keepSubtitle: true });
  if (withSubtitle && withSubtitle !== mainTitle) {
    variants.push(withSubtitle);
  }
  
  // 不带数字的版本（用于搜索系列）
  const withoutNumber = cleanTitleForSearch(title, { keepNumbers: false });
  if (withoutNumber && withoutNumber !== mainTitle && withoutNumber.length >= 2) {
    variants.push(withoutNumber);
  }
  
  // 如果有英文，也添加英文版本
  const analysis = analyzeTitle(title);
  if (analysis.hasChinese && analysis.hasEnglish) {
    const englishTitle = cleanTitleForSearch(title, { preferChinese: false });
    if (englishTitle && !variants.includes(englishTitle)) {
      variants.push(englishTitle);
    }
  }
  
  // 去重并返回
  return [...new Set(variants)];
}

/**
 * 标准化标题用于比较
 */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[\u200B-\u200F\u2028-\u202F\uFEFF]/g, '')  // 移除控制字符
    .replace(/\s+/g, '')  // 移除所有空格
    .replace(/[：:·\-—''""「」『』【】\[\]()（）]/g, '')  // 移除标点
    .trim();
}

/**
 * 计算两个标题的相似度
 */
export function calculateTitleSimilarity(title1: string, title2: string): number {
  const norm1 = normalizeTitle(title1);
  const norm2 = normalizeTitle(title2);
  
  if (norm1 === norm2) return 1;
  if (norm1.includes(norm2) || norm2.includes(norm1)) return 0.9;
  
  // 简单的字符重叠计算
  const set1 = new Set(norm1);
  const set2 = new Set(norm2);
  const intersection = new Set([...set1].filter(x => set2.has(x)));
  const union = new Set([...set1, ...set2]);
  
  return intersection.size / union.size;
}
