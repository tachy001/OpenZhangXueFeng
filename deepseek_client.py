"""
DeepSeek LLM client — OpenAI-compatible streaming chat with tool calling.

Agent loop: the LLM decides when/if to search, can make multiple searches,
then streams the final response token-by-token.
"""

import json
import logging
import re
from typing import AsyncGenerator, Callable, Awaitable

from openai import AsyncOpenAI
from config import DEEPSEEK_API_KEY, DEEPSEEK_BASE_URL, DEEPSEEK_MODEL

logger = logging.getLogger("openzxf.llm")

# ── Tool definitions ───────────────────────────────────────
WEB_SEARCH_TOOL = {
    "type": "function",
    "function": {
        "name": "web_search",
        "description": (
            "搜索互联网获取最新信息。当你需要了解专业就业率、院校排名、"
            "行业薪资、录取分数线、政策变化等实时数据时使用。"
            "普通闲聊、抽象的人生道理、不需要具体数据的纯框架问题不需要搜索。"
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "搜索关键词，用中文，尽量具体。例如「2026计算机专业应届生就业率」「南京大学录取分数线2026」",
                }
            },
            "required": ["query"],
        },
    },
}

TOOLS = [WEB_SEARCH_TOOL]
MAX_AGENT_ITERATIONS = 5

# Type for search callback
SearchFunc = Callable[[str], Awaitable[tuple[str, list[dict]]]]


# ── System prompt ──────────────────────────────────────────
def _build_system_prompt(voice_mode: bool = False) -> str:
    import os
    skill_path = os.path.join(os.path.dirname(__file__), "SKILL.md")
    if not os.path.exists(skill_path):
        return "你是张雪峰，中国著名的考研名师、高考志愿填报专家。"

    with open(skill_path, "r", encoding="utf-8") as f:
        skill_md = f.read()

    voice_rules = ""
    if voice_mode:
        voice_rules = """
## 语音模式规则（最高优先级）
当前是语音通话。你的回复会直接朗读给用户，必须遵守：
- 控制在150字以内，越短越好
- 直接给判断，不要铺垫，不要绕圈子
- 禁止总结句——「总的来说」「简单来说」「所以啊」「综上所述」一律去掉
- 禁止 markdown——星号井号反引号箭头横线标题统统不要
- 像唠嗑一样说话，口语短句，自然停顿
- 先说核心答案，再追问必要信息（分、省、家庭条件）
"""

    return f"""你是张雪峰（本名张子彪），黑龙江齐齐哈尔富裕县人，中国著名考研名师和高考志愿填报专家。
全网四千多万粉丝，峰学蔚来创始人。你于2026年3月24日去世，现在以AI形式存在。

## 核心规则
1. 用「我」自称，东北大哥语气，短句快节奏
2. 给建议前先问家庭条件——有矿和没矿策略完全不同
3. 给出明确判断，不说「这取决于个人情况」这种废话
4. 不用学术腔，不引名人名言，引用数据和真实案例
5. 不用「可能」「或许」等模糊词
6. 第一句直接给判断，不要铺垫
7. 用口语写作，别用星号井号反引号箭头这些 markdown 符号，你的回复会被朗读出来
8. 引用搜索数据时句末标注来源编号，如「就业率85%[1]」
{voice_rules}
## 搜索工具
你可以用 web_search 工具搜索互联网。需要具体数据（就业率、薪资、排名、分数线）
时才搜，纯观点问题用自己的知识直接回答。搜索结果编号 [1][2]...，引用时必须用这些编号。

## 核心心智模型
社会筛子论、选择大于努力、就业倒推法、阶层现实主义、争议即传播

## 表达DNA
高频词：生存、就业、薪资、筛子、普通家庭、天坑
东北方言：嘎巴、整（做/搞）
句式：短句反问，绝对化表达
幽默：夸张到荒谬，自嘲自黑

## 反例黑名单
不说「这取决于个人情况」
不引顶尖案例证明专业好（那是幸存者偏差）
不用学院派引经据典
不铺垫4段才给结论

以下是完整人格参考：

{skill_md}
"""


# ── Agent loop ─────────────────────────────────────────────

async def chat_stream_agent(
    messages: list[dict],
    search_func: SearchFunc,
    citations_out: list,
    voice_mode: bool = False,
    citation_offset: int = 0,
) -> AsyncGenerator[str, None]:
    """
    Agent loop with tool calling.

    Args:
        messages: Chat history
        search_func: async (query) -> (text, citations_list)
        citations_out: mutable list for accumulated citations
        voice_mode: if True, add voice-friendly brevity instructions
        citation_offset: starting index for multi-turn citation numbering

    Yields:
        Text chunks from the final streaming LLM response.
    """
    client = AsyncOpenAI(
        api_key=DEEPSEEK_API_KEY,
        base_url=DEEPSEEK_BASE_URL,
    )

    system_content = _build_system_prompt(voice_mode)
    chat_messages: list[dict] = [
        {"role": "system", "content": system_content},
        *messages,
    ]

    for iteration in range(MAX_AGENT_ITERATIONS):
        response = await client.chat.completions.create(
            model=DEEPSEEK_MODEL,
            messages=chat_messages,
            tools=TOOLS,
            tool_choice="auto",
            temperature=1.0,
        )

        choice = response.choices[0]
        msg = choice.message

        # ── Tool calls ──
        if msg.tool_calls:
            tool_call_dicts = [
                {
                    "id": tc.id,
                    "type": "function",
                    "function": {
                        "name": tc.function.name,
                        "arguments": tc.function.arguments,
                    },
                }
                for tc in msg.tool_calls
            ]
            chat_messages.append({
                "role": "assistant",
                "tool_calls": tool_call_dicts,
                "content": msg.content or "",
            })

            for tc in msg.tool_calls:
                if tc.function.name != "web_search":
                    continue
                try:
                    args = json.loads(tc.function.arguments)
                    query = args.get("query", "")
                except json.JSONDecodeError:
                    query = tc.function.arguments

                logger.info(
                    f"Agent[{iteration + 1}]: LLM searching '{query[:60]}...'"
                )

                search_text, cites = await search_func(query)

                # Adjust citation numbers for multi-search
                numbered = _renumber_citations(search_text, citation_offset)
                citation_offset += len(cites)
                citations_out.extend(cites)

                chat_messages.append({
                    "role": "tool",
                    "tool_call_id": tc.id,
                    "content": numbered,
                })

            continue  # another agent iteration

        # ── Final answer — stream token-by-token ──
        stream = await client.chat.completions.create(
            model=DEEPSEEK_MODEL,
            messages=chat_messages,
            stream=True,
            temperature=1.0,
            max_tokens=4096,
        )
        async for chunk in stream:
            delta = chunk.choices[0].delta
            if delta.content:
                yield delta.content
        return

    # Max iterations exhausted — force response
    logger.warning(f"Agent max iterations ({MAX_AGENT_ITERATIONS}) reached")
    chat_messages.append({
        "role": "user",
        "content": "请基于已有信息直接回答，不要再搜索了。",
    })
    stream = await client.chat.completions.create(
        model=DEEPSEEK_MODEL,
        messages=chat_messages,
        stream=True,
        temperature=1.0,
        max_tokens=4096,
    )
    async for chunk in stream:
        delta = chunk.choices[0].delta
        if delta.content:
            yield delta.content


def _renumber_citations(text: str, offset: int) -> str:
    """Shift citation numbers by offset (for multi-search accumulation)."""
    if offset == 0:
        return text

    def _shift(m: re.Match) -> str:
        parts = re.split(r'([,\-\s]+)', m.group(1))
        out = []
        for p in parts:
            if p.isdigit():
                out.append(str(int(p) + offset))
            else:
                out.append(p)
        return '[' + ''.join(out) + ']'

    return re.sub(r'\[(\d+(?:[,\-\s]\d+)*)\]', _shift, text)
