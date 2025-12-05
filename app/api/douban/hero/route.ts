import { NextResponse } from 'next/server';
import { createCache } from '@/lib/redis';
import { doubanSearchSubjects, doubanSubjectAbstract, getProxyStatus } from '@/lib/douban-client';

/**
 * Hero Banner API
 * GET /api/douban/hero
 * 
 * 功能：
 * 1. 获取适合作为 Hero Banner 的电影
 * 2. 提供 PC 端 16:9 横向海报（来自 TMDB）
 * 3. 提供移动端 9:16 竖向海报（来自豆瓣）
 */

// TMDB API 配置（从环境变量读取）
const TMDB_API_KEY = process.env.TMDB_API_KEY || "";
const TMDB_BASE_URL = process.env.TMDB_BASE_URL || "https://api.themoviedb.org/3";
const TMDB_IMAGE_BASE = process.env.TMDB_IMAGE_BASE || "https://image.tmdb.org/t/p/original";
const TMDB_HEADERS = {
  "accept": "application/json",
  "Authorization": `Bearer ${TMDB_API_KEY}`
};

interface HeroMovie {
  id: string;
  title: string;
  rate: string;
  cover: string;  // 竖向海报
  poster_horizontal: string;  // 横向海报 16:9
  poster_vertical: string;    // 竖向海报 9:16
  url: string;
  episode_info?: string;
  genres?: string[];
  description?: string;
}

// Redis 缓存配置
const cache = createCache(3600); // 缓存1小时
const CACHE_KEY = 'douban:hero:movies';

export async function GET() {
  try {
    // 检查 Redis 缓存
    const cachedData = await cache.get<HeroMovie[]>(CACHE_KEY);
    if (cachedData) {
      return NextResponse.json({
        code: 200,
        data: cachedData,
        source: 'redis-cache'
      });
    }

    const proxyStatus = getProxyStatus();
    console.log('🎬 开始获取 Hero Banner 数据...', proxyStatus.enabled ? `(代理: ${proxyStatus.count + " 个代理"})` : '(无代理)');

    // 获取豆瓣热映电影（使用统一客户端）
    const data = await doubanSearchSubjects({
      tag: '热门',
      page_limit: 20,
      page_start: 0
    });
    
    if (!data.subjects || data.subjects.length === 0) {
      throw new Error('未获取到电影数据');
    }

    // 选择评分最高的前5部电影作为 Hero
    const sortedMovies = data.subjects.sort((a: { rate: string }, b: { rate: string }) => {
      const rateA = parseFloat(a.rate) || 0;
      const rateB = parseFloat(b.rate) || 0;
      return rateB - rateA;
    });

    const selectedMovies = sortedMovies.slice(0, 5);

    // 从 TMDB 搜索电影并获取横向 backdrop（智能匹配）
    const searchTMDB = async (title: string, year?: string): Promise<string | null> => {
      try {
        // 清理标题，提取年份
        let cleanTitle = title;
        let extractedYear = year;
        
        // 从标题中提取年份（如果有）
        const yearMatch = title.match(/\((\d{4})\)/);
        if (yearMatch) {
          extractedYear = yearMatch[1];
          cleanTitle = title.replace(/\s*\(\d{4}\)\s*/, '').trim();
        }
        
        // 构建搜索 URL，如果有年份就加上
        let searchUrl = `${TMDB_BASE_URL}/search/movie?query=${encodeURIComponent(cleanTitle)}&language=zh-CN`;
        if (extractedYear) {
          searchUrl += `&year=${extractedYear}`;
        }
        
        const searchResponse = await fetch(searchUrl, {
          headers: TMDB_HEADERS,
          signal: AbortSignal.timeout(5000)
        });

        if (!searchResponse.ok) {
          console.log(`TMDB 搜索失败: ${title}`);
          return null;
        }

        const searchData = await searchResponse.json();
        
        if (searchData.results && searchData.results.length > 0) {
          // 智能匹配：优先选择有年份匹配的、评分高的、有 backdrop 的
          let bestMatch = null;
          let bestScore = 0;
          
          for (const movie of searchData.results.slice(0, 5)) {
            if (!movie.backdrop_path) continue;
            
            let score = 0;
            
            // 年份匹配（最重要）
            if (extractedYear && movie.release_date) {
              const movieYear = movie.release_date.substring(0, 4);
              if (movieYear === extractedYear) {
                score += 100;
              } else if (Math.abs(parseInt(movieYear) - parseInt(extractedYear)) <= 1) {
                score += 50; // 年份相差1年也可接受
              }
            }
            
            // 标题匹配度
            const movieTitle = (movie.title || movie.original_title || '').toLowerCase();
            const searchTitle = cleanTitle.toLowerCase();
            if (movieTitle === searchTitle) {
              score += 50;
            } else if (movieTitle.includes(searchTitle) || searchTitle.includes(movieTitle)) {
              score += 25;
            }
            
            // 评分和流行度（次要因素）
            score += (movie.vote_average || 0) * 2;
            score += Math.log10((movie.popularity || 1) + 1) * 5;
            
            if (score > bestScore) {
              bestScore = score;
              bestMatch = movie;
            }
          }
          
          if (bestMatch) {
            console.log(`✅ TMDB 匹配成功: ${title} -> ${bestMatch.title || bestMatch.original_title} (${bestMatch.release_date?.substring(0, 4) || 'N/A'})`);
            return `${TMDB_IMAGE_BASE}${bestMatch.backdrop_path}`;
          }
          
          // 如果没有找到好的匹配，但有结果，使用第一个有 backdrop 的
          const firstWithBackdrop = searchData.results.find((m: { backdrop_path: string }) => m.backdrop_path);
          if (firstWithBackdrop) {
            console.log(`⚠️ TMDB 使用默认匹配: ${title} -> ${firstWithBackdrop.title || firstWithBackdrop.original_title}`);
            return `${TMDB_IMAGE_BASE}${firstWithBackdrop.backdrop_path}`;
          }
        }
        
        console.log(`❌ TMDB 未找到: ${title}`);
        return null;
      } catch (error) {
        console.log(`TMDB 搜索出错: ${title}`, error);
        return null;
      }
    };

    // 为每部电影获取详情并构建数据
    const heroDataPromises = selectedMovies.map(async (movie: { id: string; title: string; rate: string; cover: string; url: string; episode_info?: string }) => {
      // 尝试获取电影详情
      let movieDetail = null;
      let releaseYear = null;
      
      try {
        movieDetail = await doubanSubjectAbstract(movie.id);
        // 从详情中提取年份
        releaseYear = movieDetail?.subject?.release_year || null;
        
        // 如果没有 release_year，尝试从 title 中提取
        if (!releaseYear && movieDetail?.subject?.title) {
          const yearMatch = movieDetail.subject.title.match(/\((\d{4})\)/);
          if (yearMatch) {
            releaseYear = yearMatch[1];
          }
        }
      } catch {
        console.log(`获取电影 ${movie.title} 详情失败，使用基础数据`);
      }

      const coverUrl = movie.cover || '';
      
      // 将豆瓣小图转换为大图（提高清晰度）
      const getHighQualityPoster = (url: string): string => {
        if (!url) return url;
        // 将 s_ratio_poster (小图) 替换为 l (大图)
        // 例如: /view/photo/s_ratio_poster/public/p123.jpg -> /view/photo/l/public/p123.jpg
        return url.replace(/\/view\/photo\/s_ratio_poster\//, '/view/photo/l/');
      };
      
      // 从 TMDB 获取横向 backdrop，传递年份信息以提高匹配准确度
      const tmdbBackdrop = await searchTMDB(movie.title, releaseYear ?? undefined);
      
      // 如果 TMDB 未匹配成功，返回 null（后续会被过滤掉）
      if (!tmdbBackdrop) {
        return null;
      }
      
      return {
        id: movie.id,
        title: movie.title,
        rate: movie.rate,
        cover: getHighQualityPoster(coverUrl),
        poster_horizontal: tmdbBackdrop, // 使用 TMDB backdrop
        poster_vertical: getHighQualityPoster(coverUrl), // 使用豆瓣高清竖向海报
        url: movie.url,
        episode_info: movie.episode_info || '',
        genres: movieDetail?.subject?.types || [],
        description: movieDetail?.subject?.short_comment?.content || ''
      };
    });

    const heroDataListRaw = await Promise.all(heroDataPromises);
    
    // 过滤掉 TMDB 未匹配的数据
    const heroDataList = heroDataListRaw.filter((item): item is NonNullable<typeof item> => item !== null);

    // 更新 Redis 缓存
    await cache.set(CACHE_KEY, heroDataList);

    console.log('✅ Hero Banner 数据获取成功，共', heroDataList.length, '部电影');

    return NextResponse.json({
      code: 200,
      data: heroDataList,
      source: 'fresh'
    });

  } catch (error) {
    console.error('❌ Hero Banner 数据获取失败:', error);
    
    return NextResponse.json(
      {
        code: 500,
        msg: 'error',
        error: error instanceof Error ? error.message : '未知错误'
      },
      { status: 500 }
    );
  }
}

/**
 * 清除缓存接口
 * DELETE /api/douban/hero
 */
export async function DELETE() {
  await cache.del(CACHE_KEY);
  
  return NextResponse.json({
    code: 200,
    message: 'Hero Banner 缓存已清除'
  });
}
