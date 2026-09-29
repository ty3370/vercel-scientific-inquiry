import { sql } from '@vercel/postgres';
import OpenAI from 'openai';
import { NOVICE_SCORE_THRESHOLD } from '../../config';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || '',
});

const MODEL = 'gpt-6-luna';

// 15개 체크리스트 채점 프롬프트
const EVALUATION_SYSTEM_PROMPT = `
당신은 고등학생의 과학 자유 탐구 설계를 전문적으로 평가하는 심사위원입니다.
학생이 작성한 '가설'과 '실험 절차'를 다음 15가지 채점 기준에 따라 엄밀히 평가하세요.

[체크리스트 기준]
(1) 실험 가설 작성하기
1. 조작 변인이 언급되었는가?
2. 종속 변인이 언급되었는가?
3. 변인 간 관계가 제시되었는가? (A는 B에 영향을 준다)
4. 변인 간 방향성이 제시되었는가? (A가 ~할수록 B가 ~하다)
5. 실제로 실험을 통해 정량적으로 검증할 수 있는 과학적으로 타당한 가설인가?

(2) 실험 절차 설계하기
6. 가설의 조작 변인이 실험 절차에 언급되었는가?
7. 가설의 종속 변인이 실험 절차에 언급되었는가?
8. 조작 변인을 조절하기 위한 구체적 방법이 제시되었는가?
9. 통제 변인이 언급되었는가?
10. 통제 변인을 일정하게 유지하기 위한 구체적 방법이 제시되었는가?
11. 변인의 정량적 측정 방법이 제시되어 있는가?
12. 비교 기준이 되는 대조군과 실험 조건을 적용한 실험군이 구분되어 있는가?
13. 실제로 실험에 사용할 준비물이 제시되어 있는가?
14. 반복 실험을 언급했는가?
15. 절차가 시간 순서 및 논리적 흐름에 맞게 단계별로 나열되었는가?

[출력 형식 규칙]
반드시 다음 JSON 형식으로만 응답해야 합니다. 
각 항목의 score는 반드시 0 또는 1의 정수여야 하며, total_score는 15개 항목 score의 총합(0~15 정수)이어야 합니다.
{
  "checklist": [
    { "id": 1, "category": "가설", "item": "조작 변인이 언급되었는가?", "score": 1, "reason": "이유 설명" },
    ... 15번 항목까지 순서대로
  ],
  "total_score": 12
}
`;

export async function POST(req) {
  try {
    const body = await req.json();
    const { action, number, name, code } = body;

    // 1. 학생 로그인 및 기존 진행 세션 조회 (대화 이어가기)
    if (action === 'login') {
      const { rows } = await sql`
        SELECT * FROM inquiry_sessions 
        WHERE number = ${number} AND name = ${name} AND code = ${code};
      `;

      if (rows.length > 0) {
        return Response.json({
          exists: true,
          session: rows[0]
        });
      }

      // 신규 학생 세션 생성
      await sql`
        INSERT INTO inquiry_sessions (number, name, code, current_step)
        VALUES (${number}, ${name}, ${code}, 2)
        ON CONFLICT (number, name, code) DO NOTHING;
      `;

      return Response.json({
        exists: false,
        current_step: 2
      });
    }

    // 2. 2페이지: 1차 탐구 설계 15개 항목 채점
    if (action === 'evaluate_step2') {
      const { hypothesis, procedure } = body;

      const response = await openai.chat.completions.create({
        model: MODEL,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: EVALUATION_SYSTEM_PROMPT
          },
          {
            role: 'user',
            content: `[학생의 가설]\n${hypothesis}\n\n[학생의 실험 절차]\n${procedure}`
          }
        ]
      });

      const evalResult = JSON.parse(
        response.choices[0].message.content
      );

      const checklist = Array.isArray(evalResult.checklist)
        ? evalResult.checklist
        : [];

      const calculatedTotalScore = checklist.reduce(
        (sum, item) =>
          sum + (Number(item.score) === 1 ? 1 : 0),
        0
      );

      const totalScore =
        checklist.length > 0
          ? calculatedTotalScore
          : (parseInt(evalResult.total_score, 10) || 0);

      evalResult.total_score = totalScore;

      // DB 저장
      await sql`
        UPDATE inquiry_sessions
        SET initial_hypothesis = ${hypothesis},
            initial_procedure = ${procedure},
            evaluation_details = ${JSON.stringify(evalResult)}::jsonb,
            total_score = ${totalScore},
            current_step = 3,
            updated_at = NOW()
        WHERE number = ${number} AND name = ${name} AND code = ${code};
      `;

      return Response.json({
        evaluation: evalResult,
        totalScore
      });
    }

    // 3. 3페이지: 첫 AI 메시지 생성 (라우터 분기: 초보적 vs 숙련된)
    if (action === 'get_initial_chat') {
      const { rows } = await sql`
        SELECT initial_hypothesis,
               initial_procedure,
               evaluation_details,
               total_score,
               chat_messages
        FROM inquiry_sessions 
        WHERE number = ${number}
          AND name = ${name}
          AND code = ${code};
      `;

      const session = rows[0];

      if (!session) {
        return Response.json(
          { error: '세션을 찾을 수 없습니다.' },
          { status: 404 }
        );
      }

      const evalDetails = session.evaluation_details;

      const fallbackScore = Array.isArray(evalDetails?.checklist)
        ? evalDetails.checklist.reduce(
            (sum, item) =>
              sum + (Number(item.score) === 1 ? 1 : 0),
            0
          )
        : null;

      const totalScore =
        session.total_score !== null &&
        session.total_score !== undefined
          ? Number(session.total_score)
          : fallbackScore;

      if (
        totalScore === null ||
        !Number.isFinite(totalScore)
      ) {
        return Response.json(
          {
            error:
              '총점을 확인할 수 없습니다. 2페이지 채점을 다시 진행해 주세요.'
          },
          { status: 409 }
        );
      }

      if (
        session.chat_messages &&
        session.chat_messages.length > 0
      ) {
        if (
          session.total_score === null ||
          session.total_score === undefined
        ) {
          await sql`
            UPDATE inquiry_sessions
            SET total_score = ${totalScore},
                updated_at = NOW()
            WHERE number = ${number}
              AND name = ${name}
              AND code = ${code};
          `;
        }

        return Response.json({
          messages: session.chat_messages,
          totalScore
        });
      }

      let firstMessage = '';

      if (totalScore <= NOVICE_SCORE_THRESHOLD) {
        // 초보적 탐구 설계자: 평가 결과(점수 및 피드백) 공개
        const weakItems = evalDetails.checklist
          .filter(i => i.score === 0)
          .map(
            i => `${i.item} / ${i.reason}`
          )
          .join('\n');

        firstMessage =
          `안녕! 나는 탐구를 돕는 '과학탐구 도우미'야.\n\n` +
          `작성해 준 가설과 실험 절차를 평가해 보았어 ` +
          `(총점: ${totalScore}/15점).\n\n` +
          `[보완이 필요한 부분]\n${weakItems}\n\n` +
          `네 실험에서 가장 궁금하거나 확인하고 싶은 점은 무엇이야? ` +
          `다 물어보고 나면 '궁금한 건 다 물어봤어'라고 말해줘.`;
      } else {
        // 숙련된 탐구 설계자: 평가 결과 비공개, 질문 유도
        firstMessage =
          `안녕! 나는 탐구를 돕는 '과학탐구 도우미'야.\n\n` +
          `네가 작성한 가설과 실험 절차를 꼼꼼하게 잘 확인했어.\n\n` +
          `그럼 시작해 보자. 네 실험에서 가장 궁금하거나 확인하고 싶은 점은 무엇이야? ` +
          `다 물어보고 나면 '궁금한 건 다 물어봤어'라고 이야기해 줘.`;
      }

      const initialChat = [
        {
          role: 'assistant',
          content: firstMessage
        }
      ];

      await sql`
        UPDATE inquiry_sessions
        SET chat_messages = ${JSON.stringify(initialChat)}::jsonb,
            updated_at = NOW()
        WHERE number = ${number}
          AND name = ${name}
          AND code = ${code};
      `;

      return Response.json({
        messages: initialChat,
        totalScore
      });
    }

    // 4. 3페이지: 학생-AI 상호작용 대화 진행 (라우터 분기)
    if (action === 'send_chat') {
      const { userPrompt } = body;

      const { rows } = await sql`
        SELECT initial_hypothesis,
               initial_procedure,
               evaluation_details,
               total_score,
               chat_messages
        FROM inquiry_sessions 
        WHERE number = ${number}
          AND name = ${name}
          AND code = ${code};
      `;

      const session = rows[0];

      if (!session) {
        return Response.json(
          { error: '세션을 찾을 수 없습니다.' },
          { status: 404 }
        );
      }

      const messages = Array.isArray(session.chat_messages)
        ? session.chat_messages
        : [];

      const chatFallbackScore = Array.isArray(
        session.evaluation_details?.checklist
      )
        ? session.evaluation_details.checklist.reduce(
            (sum, item) =>
              sum + (Number(item.score) === 1 ? 1 : 0),
            0
          )
        : null;

      const chatTotalScore =
        session.total_score !== null &&
        session.total_score !== undefined
          ? Number(session.total_score)
          : chatFallbackScore;

      const isNovice =
        Number.isFinite(chatTotalScore) &&
        chatTotalScore <= NOVICE_SCORE_THRESHOLD;

      // 시스템 프롬프트 라우팅 설정
      const systemInstruction = `
당신은 고등학생의 자유 탐구를 돕는 챗봇 '과학탐구 도우미'입니다.
학생의 1차 가설: ${session.initial_hypothesis}
학생의 1차 실험 절차: ${session.initial_procedure}
평가 결과(채점 기준 미흡 항목): ${JSON.stringify(session.evaluation_details)}

[최우선 출력 형식 규칙]
- 모든 답변은 일반 텍스트로만 작성하세요.
- 마크다운을 절대로 사용하지 마세요.
- #, ##, *, **, -, >, \`, \`\`\` 등의 마크다운 문법을 사용하지 마세요.
- 마크다운을 대신해 일반 문장과 줄바꿈만 사용하세요.

[역할 및 단계별 규칙]
- 1단계: AI가 첫 메시지에서 대화를 시작한 뒤, 학생이 궁금한 것을 질문하는 단계입니다.
  ${isNovice
    ? '학생의 질문에 답변할 때는 불필요한 추가 정보 없이 간결하게 핵심만 답변하세요 (10글자 내외 권장).'
    : '학생에게 답변할 때 관련 과학 지식이나 정보를 풍부하게 제공하세요. 대화는 한 줄 이내를 기본으로 합니다.'}
  절대 실험 가설이나 절차를 직접 알려주지 마세요. 학생이 스스로 사고하도록 유도하세요.
  첫 AI 메시지 이후에는 학생이 더이상 질문이 없다고 말하기 전까지 학생의 질문에 답변하고 필요한 설명을 제공하세요.

- 2단계: 학생이 "궁금한 건 다 물어봤어" 또는 더 이상 질문이 없다고 말하면 시작됩니다.
  미흡한 채점 기준 항목들에 대해 한 번에 하나씩만 질문하여 학생 스스로 실험을 개선하도록 유도하세요.
  2단계에서는 최소 3개 이상의 질문을 해야 합니다.

- [다음] 버튼 안내 규칙:
  반드시 아래 2가지 조건이 모두 충족되었을 때만 학생에게 "[다음] 버튼을 눌러 다음 단계로 진행하세요"라고 안내하세요:
  ① 평가 결과에서 미흡했던 모든 항목을 하나도 빠짐없이 대화로 논의했다.
  ② 2단계에서 3개 이상의 질문을 진행했다.
  조건이 충족되기 전에는 절대로 [다음] 버튼을 누르라고 하지 마세요.
`;

      const formattedMessages = [
        {
          role: 'system',
          content: systemInstruction
        },
        ...messages.map(m => ({
          role: m.role,
          content: m.content
        })),
        {
          role: 'user',
          content: userPrompt
        }
      ];

      const response =
        await openai.chat.completions.create({
          model: MODEL,
          messages: formattedMessages
        });

      const assistantText =
        response.choices[0].message.content;

      const updatedMessages = [
        ...messages,
        {
          role: 'user',
          content: userPrompt
        },
        {
          role: 'assistant',
          content: assistantText
        }
      ];

      await sql`
        UPDATE inquiry_sessions
        SET chat_messages = ${JSON.stringify(updatedMessages)}::jsonb,
            total_score = CASE
              WHEN total_score IS NULL
                AND ${chatTotalScore !== null && Number.isFinite(chatTotalScore)}
              THEN ${chatTotalScore}
              ELSE total_score
            END,
            updated_at = NOW()
        WHERE number = ${number}
          AND name = ${name}
          AND code = ${code};
      `;

      return Response.json({
        updatedMessages
      });
    }

    // 5. 진행 상태/초안 저장
    if (action === 'save_progress') {
      const {
        currentStep,
        initialHypothesis,
        initialProcedure,
        revisedHypothesis,
        revisedProcedure,
        messages
      } = body;

      await sql`
        UPDATE inquiry_sessions
        SET initial_hypothesis = COALESCE(${initialHypothesis}, initial_hypothesis),
            initial_procedure = COALESCE(${initialProcedure}, initial_procedure),
            revised_hypothesis = COALESCE(${revisedHypothesis}, revised_hypothesis),
            revised_procedure = COALESCE(${revisedProcedure}, revised_procedure),
            chat_messages = CASE
              WHEN ${Array.isArray(messages)}
              THEN ${JSON.stringify(messages)}::jsonb
              ELSE chat_messages
            END,
            current_step = ${Number(currentStep) || 2},
            updated_at = NOW()
        WHERE number = ${number}
          AND name = ${name}
          AND code = ${code};
      `;

      return Response.json({
        success: true
      });
    }

    // 6. 4페이지: 조건 검증 및 요약 생성 (사용자 수정본 유지)
    if (action === 'verify_and_summarize') {
      const { rows } = await sql`
        SELECT chat_messages
        FROM inquiry_sessions 
        WHERE number = ${number}
          AND name = ${name}
          AND code = ${code};
      `;

      const chatMessages =
        rows[0]?.chat_messages || [];

      const chatHistory = chatMessages
        .map(m => `${m.role}: ${m.content}`)
        .join('\n');

      const verificationPrompt = `
당신은 대화 검증관입니다. 학생과 과학탐구 도우미의 대화 기록을 분석하세요.
검증 조건:
1. 대화 중에 도우미가 '[다음] 버튼을 눌러도 된다'는 허가 발언을 했는가?
2. 2단계에서 최소 3개 이상의 질문-답변 상호작용이 있었는가?

출력 형식 (반드시 JSON):
{
  "passed": true 또는 false,
  "reason": "검증 결과 이유",
  "summary": "passed가 true일 경우에만 작성: 대화 내용 요약 (수정하기로 한 부분 중심)"
}
`;

      const response =
        await openai.chat.completions.create({
          model: MODEL,
          response_format: {
            type: 'json_object'
          },
          messages: [
            {
              role: 'system',
              content: verificationPrompt
            },
            {
              role: 'user',
              content: `[대화 기록]\n${chatHistory}`
            }
          ]
        });

      const resJson = JSON.parse(
        response.choices[0].message.content
      );

      if (resJson.passed) {
        await sql`
          UPDATE inquiry_sessions
          SET ai_summary = ${resJson.summary},
              current_step = 4,
              updated_at = NOW()
          WHERE number = ${number}
            AND name = ${name}
            AND code = ${code};
        `;
      }

      return Response.json(resJson);
    }

    // 7. 4페이지: 2차 탐구 설계서 최종 저장
    if (action === 'save_final') {
      const {
        revisedHypothesis,
        revisedProcedure
      } = body;

      await sql`
        UPDATE inquiry_sessions
        SET revised_hypothesis = ${revisedHypothesis},
            revised_procedure = ${revisedProcedure},
            current_step = 4,
            updated_at = NOW()
        WHERE number = ${number}
          AND name = ${name}
          AND code = ${code};
      `;

      return Response.json({
        success: true
      });
    }

    return Response.json(
      { error: '알 수 없는 요청입니다.' },
      { status: 400 }
    );
  } catch (error) {
    console.error('[API Error]:', error);

    return Response.json(
      { error: error.message },
      { status: 500 }
    );
  }
}
