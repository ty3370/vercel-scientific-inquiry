'use client';

import { useEffect, useRef, useState } from 'react';

export default function Home() {
  const [step, setStep] = useState(1);
  const [userInfo, setUserInfo] = useState({ number: '', name: '', code: '' });
  const [loading, setLoading] = useState(false);
  const [loadingText, setLoadingText] = useState('');

  // 2페이지 상태
  const [initialHypothesis, setInitialHypothesis] = useState('');
  const [initialProcedure, setInitialProcedure] = useState('');
  const [totalScore, setTotalScore] = useState(null);

  // 3페이지 상태
  const [messages, setMessages] = useState([]);
  const [userPrompt, setUserPrompt] = useState('');
  const [chatLoading, setChatLoading] = useState(false);
  const chatContainerRef = useRef(null);

  useEffect(() => {
    if (!chatContainerRef.current) return;

    requestAnimationFrame(() => {
      if (chatContainerRef.current) {
        chatContainerRef.current.scrollTop =
          chatContainerRef.current.scrollHeight;
      }
    });
  }, [messages, chatLoading]);

  // 4페이지 상태
  const [verificationResult, setVerificationResult] = useState(null);
  const [revisedHypothesis, setRevisedHypothesis] = useState('');
  const [revisedProcedure, setRevisedProcedure] = useState('');
  const [isCompleted, setIsCompleted] = useState(false);

  // 진행 상태 저장
  const saveProgress = async (targetStep) => {
    try {
      await fetch('/api/inquiry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'save_progress',
          ...userInfo,
          currentStep: targetStep,
          initialHypothesis,
          initialProcedure,
          revisedHypothesis,
          revisedProcedure,
          messages
        })
      });
    } catch (err) {
      console.error('진행 상태 저장 오류:', err);
    }
  };

  // 1페이지: 로그인 및 세션 복원
  const handleLogin = async () => {
    if (!userInfo.number.trim() || !userInfo.name.trim() || !userInfo.code.trim()) {
      return alert('학번, 이름, 식별 코드를 모두 입력해 주세요.');
    }
    setLoading(true);
    setLoadingText('학생 정보를 확인하고 있습니다...');

    try {
      const res = await fetch('/api/inquiry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'login', ...userInfo })
      });
      const data = await res.json();

      if (data.exists && data.session) {
        const s = data.session;
        setInitialHypothesis(s.initial_hypothesis || '');
        setInitialProcedure(s.initial_procedure || '');

        const restoredTotalScore =
          s.total_score !== null && s.total_score !== undefined
            ? Number(s.total_score)
            : (Array.isArray(s.evaluation_details?.checklist)
                ? s.evaluation_details.checklist.reduce(
                    (sum, item) => sum + (Number(item.score) === 1 ? 1 : 0),
                    0
                  )
                : null);

        setTotalScore(Number.isFinite(restoredTotalScore) ? restoredTotalScore : null);
        setMessages(s.chat_messages || []);
        setRevisedHypothesis(s.revised_hypothesis || '');
        setRevisedProcedure(s.revised_procedure || '');

        if (s.revised_hypothesis && s.revised_procedure) {
          setIsCompleted(true);
        }

        // 기존 진행 페이지로 이동
        const targetStep = s.current_step || 2;
        setStep(targetStep);

        if (targetStep === 3 && (!s.chat_messages || s.chat_messages.length === 0)) {
          await loadInitialChat();
        }
      } else {
        setStep(2);
      }
    } catch (err) {
      alert('오류가 발생했습니다: ' + err.message);
    } finally {
      setLoading(false);
    }
  };

  // 2페이지 -> 3페이지 (15개 항목 채점)
  const handleEvaluateStep2 = async () => {
    if (!initialHypothesis.trim() || !initialProcedure.trim()) {
      return alert('가설과 실험 절차를 모두 입력해 주세요.');
    }

    setLoading(true);
    setLoadingText('AI가 가설과 실험 절차를 검토하고 있습니다...');

    try {
      const res = await fetch('/api/inquiry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'evaluate_step2',
          ...userInfo,
          hypothesis: initialHypothesis,
          procedure: initialProcedure
        })
      });

      const data = await res.json();

      const numericTotalScore = Number(data.totalScore);
      setTotalScore(Number.isFinite(numericTotalScore) ? numericTotalScore : null);
      setStep(3);

      // 3페이지 첫 안내 대화 로드
      await loadInitialChat();
    } catch (err) {
      alert('채점 중 오류가 발생했습니다: ' + err.message);
    } finally {
      setLoading(false);
    }
  };

  // 3페이지: 첫 AI 대화 로드
  const loadInitialChat = async () => {
    const res = await fetch('/api/inquiry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'get_initial_chat', ...userInfo })
    });

    const data = await res.json();

    if (data.totalScore !== undefined) {
      const numericTotalScore = Number(data.totalScore);
      setTotalScore(Number.isFinite(numericTotalScore) ? numericTotalScore : null);
    }

    if (data.messages) {
      setMessages(data.messages);
    }
  };

  // 3페이지: 대화 전송
  const handleSendMessage = async () => {
    if (!userPrompt.trim() || loading || chatLoading) return;

    const currentInput = userPrompt;
    setUserPrompt('');
    setChatLoading(true);

    try {
      const res = await fetch('/api/inquiry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'send_chat',
          ...userInfo,
          userPrompt: currentInput,
          messages
        })
      });

      const data = await res.json();

      if (data.updatedMessages) {
        setMessages(data.updatedMessages);
      } else if (data.error) {
        alert('대화 중 오류가 발생했습니다: ' + data.error);
      }
    } catch (err) {
      alert('대화 중 오류가 발생했습니다: ' + err.message);
    } finally {
      setChatLoading(false);
    }
  };

  // 3페이지 -> 4페이지: 대화 검증 및 요약 생성
  const handleProceedToStep4 = async () => {
    setLoading(true);
    setLoadingText('탐구 대화 조건이 모두 충족되었는지 검증하고 있습니다...');

    try {
      const res = await fetch('/api/inquiry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'verify_and_summarize', ...userInfo })
      });

      const data = await res.json();
      setVerificationResult(data);
      setStep(4);
    } catch (err) {
      alert('검증 중 오류가 발생했습니다: ' + err.message);
    } finally {
      setLoading(false);
    }
  };

  // 4페이지: 최종 2차 탐구 설계서 저장
  const handleSaveFinal = async () => {
    if (!revisedHypothesis.trim() || !revisedProcedure.trim()) {
      return alert('수정된 2차 가설과 실험 절차를 모두 입력해 주세요.');
    }

    setLoading(true);
    setLoadingText('최종 탐구 설계서를 저장하고 있습니다...');

    try {
      const res = await fetch('/api/inquiry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'save_final',
          ...userInfo,
          revisedHypothesis,
          revisedProcedure
        })
      });

      const data = await res.json();

      if (data.success) {
        setIsCompleted(true);
        alert('🎉 최종 2차 탐구 설계서가 성공적으로 저장되었습니다!');
      }
    } catch (err) {
      alert('저장 중 오류 발생: ' + err.message);
    } finally {
      setLoading(false);
    }
  };

  // 공통 로딩 인디케이터
  if (loading) {
    return (
      <div
        style={{
          minHeight: '100vh',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          color: '#f8fafc'
        }}
      >
        <div style={{ fontSize: '40px', marginBottom: '16px' }}>⏳</div>
        <p style={{ fontSize: '18px', fontWeight: '600' }}>
          {loadingText || '처리 중입니다...'}
        </p>
      </div>
    );
  }

  // ==================== 1페이지: 로그인 ====================
  if (step === 1) {
    return (
      <div
        style={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center'
        }}
      >
        <div
          style={{
            backgroundColor: '#1e293b',
            padding: '40px',
            borderRadius: '24px',
            width: '100%',
            maxWidth: '420px',
            border: '1px solid #334155'
          }}
        >
          <div style={{ textAlign: 'center', marginBottom: '28px' }}>
            <span style={{ fontSize: '48px' }}>🔬</span>
            <h1
              style={{
                color: '#f8fafc',
                fontSize: '24px',
                fontWeight: '700',
                marginTop: '12px'
              }}
            >
              AI-탐구 설계 도우미
            </h1>
            <p style={{ color: '#94a3b8', fontSize: '14px', margin: 0 }}>
              학번, 이름, 코드를 입력해 시작하거나 이어하세요.
            </p>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
            <input
              style={{
                padding: '14px',
                borderRadius: '12px',
                border: '1px solid #475569',
                backgroundColor: '#0f172a',
                color: '#fff',
                fontSize: '15px'
              }}
              placeholder="학번 (예: 10101)"
              value={userInfo.number}
              onChange={e =>
                setUserInfo({ ...userInfo, number: e.target.value })
              }
            />

            <input
              style={{
                padding: '14px',
                borderRadius: '12px',
                border: '1px solid #475569',
                backgroundColor: '#0f172a',
                color: '#fff',
                fontSize: '15px'
              }}
              placeholder="이름 (예: 홍길동)"
              value={userInfo.name}
              onChange={e =>
                setUserInfo({ ...userInfo, name: e.target.value })
              }
            />

            <input
              style={{
                padding: '14px',
                borderRadius: '12px',
                border: '1px solid #475569',
                backgroundColor: '#0f172a',
                color: '#fff',
                fontSize: '15px'
              }}
              placeholder="식별코드"
              title="타인의 학번과 이름으로 접속하는 것을 방지하기 위해 자신만 기억할 수 있는 코드를 입력하세요."
              value={userInfo.code}
              onChange={e =>
                setUserInfo({ ...userInfo, code: e.target.value })
              }
            />

            <button
              style={{
                marginTop: '10px',
                padding: '16px',
                borderRadius: '12px',
                border: 'none',
                backgroundColor: '#3b82f6',
                color: '#fff',
                fontWeight: '700',
                fontSize: '16px',
                cursor: 'pointer'
              }}
              onClick={handleLogin}
            >
              시작하기
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ==================== 2페이지: 1차 탐구 설계 ====================
  if (step === 2) {
    return (
      <div
        style={{
          maxWidth: '800px',
          margin: '40px auto',
          padding: '32px',
          backgroundColor: '#1e293b',
          borderRadius: '24px',
          border: '1px solid #334155',
          color: '#f8fafc'
        }}
      >
        <h2
          style={{
            fontSize: '22px',
            color: '#38bdf8',
            marginBottom: '8px'
          }}
        >
          📋 1차 탐구 설계 작성
        </h2>

        <p
          style={{
            color: '#94a3b8',
            fontSize: '14px',
            marginBottom: '24px'
          }}
        >
          작성한 가설과 실험 절차를 입력해 주세요. 입력 후에는 [다음] 버튼을 클릭하세요.
        </p>

        <label
          style={{
            display: 'block',
            fontWeight: '600',
            marginBottom: '8px'
          }}
        >
          1. 실험 가설
        </label>

        <textarea
          style={{
            width: '100%',
            height: '100px',
            padding: '14px',
            borderRadius: '12px',
            border: '1px solid #475569',
            backgroundColor: '#0f172a',
            color: '#fff',
            fontSize: '15px',
            boxSizing: 'border-box',
            marginBottom: '20px'
          }}
          value={initialHypothesis}
          onChange={e => setInitialHypothesis(e.target.value)}
        />

        <label
          style={{
            display: 'block',
            fontWeight: '600',
            marginBottom: '8px'
          }}
        >
          2. 실험 절차
        </label>

        <textarea
          style={{
            width: '100%',
            height: '220px',
            padding: '14px',
            borderRadius: '12px',
            border: '1px solid #475569',
            backgroundColor: '#0f172a',
            color: '#fff',
            fontSize: '15px',
            boxSizing: 'border-box',
            marginBottom: '24px'
          }}
          value={initialProcedure}
          onChange={e => setInitialProcedure(e.target.value)}
        />

        <button
          style={{
            width: '100%',
            padding: '16px',
            borderRadius: '12px',
            border: 'none',
            backgroundColor: '#2563eb',
            color: '#fff',
            fontWeight: '700',
            fontSize: '16px',
            cursor: 'pointer'
          }}
          onClick={handleEvaluateStep2}
        >
          다음 단계로 ➔
        </button>
      </div>
    );
  }

  // ==================== 3페이지: 상호작용 대화 ====================
  if (step === 3) {
    const numericTotalScore = Number(totalScore);
    const hasTotalScore = Number.isFinite(numericTotalScore);
    const isNovice = hasTotalScore && numericTotalScore <= 10;

    return (
      <div
        style={{
          maxWidth: '900px',
          margin: '30px auto',
          padding: '24px',
          backgroundColor: '#1e293b',
          borderRadius: '24px',
          border: '1px solid #334155',
          color: '#f8fafc',
          display: 'flex',
          flexDirection: 'column',
          height: '88vh'
        }}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            borderBottom: '1px solid #334155',
            paddingBottom: '16px',
            marginBottom: '16px'
          }}
        >
          <div>
            <h2
              style={{
                fontSize: '20px',
                margin: 0,
                color: '#38bdf8'
              }}
            >
              💬 과학탐구 도우미와의 대화
            </h2>

            <span
              style={{
                fontSize: '13px',
                color: '#94a3b8'
              }}
            >
              유형:{' '}
              <b
                style={{
                  color: isNovice ? '#f87171' : '#4ade80'
                }}
              >
                {hasTotalScore
                  ? isNovice
                    ? '지시적·초점화'
                    : '정교화·확장'
                  : '채점 확인 중'}
              </b>{' '}
              (총점: {hasTotalScore ? numericTotalScore : '-'}/15점)
            </span>
          </div>

          <span
            style={{
              fontSize: '14px',
              color: '#cbd5e1'
            }}
          >
            👤 {userInfo.number} {userInfo.name}
          </span>
        </div>

        {/* 대화 목록 창 */}
        <div
          ref={chatContainerRef}
          style={{
            flex: 1,
            backgroundColor: '#0f172a',
            borderRadius: '16px',
            padding: '20px',
            overflowY: 'auto',
            display: 'flex',
            flexDirection: 'column',
            gap: '16px',
            border: '1px solid #334155'
          }}
        >
          {messages.map((m, idx) => (
            <div
              key={idx}
              style={{
                display: 'flex',
                justifyContent:
                  m.role === 'user' ? 'flex-end' : 'flex-start'
              }}
            >
              <div
                style={{
                  maxWidth: '80%',
                  padding: '14px 18px',
                  borderRadius: '16px',
                  fontSize: '15px',
                  lineHeight: '1.6',
                  whiteSpace: 'pre-wrap',
                  backgroundColor:
                    m.role === 'user' ? '#2563eb' : '#334155',
                  color: '#ffffff',
                  borderBottomRightRadius:
                    m.role === 'user' ? '4px' : '16px',
                  borderBottomLeftRadius:
                    m.role === 'assistant' ? '4px' : '16px'
                }}
              >
                <div
                  style={{
                    fontSize: '12px',
                    fontWeight: '700',
                    marginBottom: '4px',
                    opacity: 0.8
                  }}
                >
                  {m.role === 'user'
                    ? '나'
                    : '🤖 과학탐구 도우미'}
                </div>

                {m.content}
              </div>
            </div>
          ))}

          {chatLoading && (
            <div
              style={{
                display: 'flex',
                justifyContent: 'flex-start'
              }}
            >
              <div
                style={{
                  maxWidth: '80%',
                  padding: '14px 18px',
                  borderRadius: '16px',
                  borderBottomLeftRadius: '4px',
                  fontSize: '15px',
                  lineHeight: '1.6',
                  backgroundColor: '#334155',
                  color: '#cbd5e1'
                }}
              >
                <div
                  style={{
                    fontSize: '12px',
                    fontWeight: '700',
                    marginBottom: '4px',
                    opacity: 0.8
                  }}
                >
                  🤖 과학탐구 도우미
                </div>

                답변을 작성하고 있어요...
              </div>
            </div>
          )}
        </div>

        {/* 퀵 액션 & 입력창 */}
        <div
          style={{
            marginTop: '16px',
            display: 'flex',
            flexDirection: 'column',
            gap: '10px'
          }}
        >
          <div
            style={{
              display: 'flex',
              gap: '8px'
            }}
          >
            <button
              style={{
                padding: '8px 12px',
                borderRadius: '8px',
                border: '1px solid #475569',
                backgroundColor: '#1e293b',
                color: '#cbd5e1',
                fontSize: '13px',
                cursor: 'pointer'
              }}
              onClick={() =>
                setUserPrompt('궁금한 건 다 물어봤어')
              }
            >
              💡 "궁금한 건 다 물어봤어" 자동 입력
            </button>
          </div>

          <div
            style={{
              display: 'flex',
              gap: '12px'
            }}
          >
            <textarea
              style={{
                flex: 1,
                height: '70px',
                padding: '12px',
                borderRadius: '12px',
                border: '1px solid #475569',
                backgroundColor: '#0f172a',
                color: '#fff',
                fontSize: '14px',
                resize: 'none'
              }}
              placeholder="질문이나 답변을 입력하세요..."
              value={userPrompt}
              disabled={chatLoading}
              onChange={e => setUserPrompt(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handleSendMessage();
                }
              }}
            />

            <button
              style={{
                width: '100px',
                borderRadius: '12px',
                border: 'none',
                backgroundColor: '#10b981',
                color: '#fff',
                fontWeight: '700',
                cursor: 'pointer'
              }}
              onClick={handleSendMessage}
              disabled={chatLoading}
            >
              {chatLoading ? '답변 중' : '전송'}
            </button>
          </div>
        </div>

        {/* 하단 이동 버튼 */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            marginTop: '16px'
          }}
        >
          <button
            style={{
              padding: '12px 24px',
              borderRadius: '10px',
              border: 'none',
              backgroundColor: '#8b5cf6',
              color: '#fff',
              fontWeight: '700',
              cursor: 'pointer'
            }}
            onClick={handleProceedToStep4}
          >
            다음 단계 진행 ▶
          </button>
        </div>
      </div>
    );
  }

  // ==================== 4페이지: 조건 검증 및 2차 설계서 작성 ====================
  if (step === 4) {
    if (verificationResult && !verificationResult.passed) {
      return (
        <div
          style={{
            maxWidth: '650px',
            margin: '80px auto',
            padding: '40px',
            backgroundColor: '#1e293b',
            borderRadius: '24px',
            border: '1px solid #ef4444',
            textAlign: 'center',
            color: '#f8fafc'
          }}
        >
          <span style={{ fontSize: '56px' }}>⚠️</span>

          <h2
            style={{
              fontSize: '22px',
              color: '#ef4444',
              marginTop: '16px'
            }}
          >
            대화가 아직 충분하지 않습니다!
          </h2>

          <p
            style={{
              color: '#cbd5e1',
              fontSize: '15px',
              lineHeight: '1.7',
              margin: '20px 0'
            }}
          >
            {verificationResult.reason ||
              '[이전] 버튼을 눌러 과학탐구 도우미와 더 대화해야 합니다.'}
          </p>

          <button
            style={{
              padding: '14px 28px',
              borderRadius: '12px',
              border: 'none',
              backgroundColor: '#3b82f6',
              color: '#fff',
              fontWeight: '700',
              cursor: 'pointer'
            }}
            onClick={() => setStep(3)}
          >
            ◀ 3페이지로 돌아가 대화 계속하기
          </button>
        </div>
      );
    }

    return (
      <div
        style={{
          maxWidth: '900px',
          margin: '40px auto',
          padding: '32px',
          backgroundColor: '#1e293b',
          borderRadius: '24px',
          border: '1px solid #334155',
          color: '#f8fafc'
        }}
      >
        <h2
          style={{
            fontSize: '22px',
            color: '#38bdf8',
            marginBottom: '8px'
          }}
        >
          ✨ 탐구 내용 요약 및 2차 설계서
        </h2>

        <p
          style={{
            color: '#94a3b8',
            fontSize: '14px',
            marginBottom: '24px'
          }}
        >
          AI와의 대화 요약을 확인하고, 발전된 최종 2차 탐구 설계서를 작성하여 저장해 주세요.
        </p>

        {/* AI 요약 박스 */}
        <div
          style={{
            backgroundColor: '#0f172a',
            padding: '20px',
            borderRadius: '16px',
            border: '1px solid #334155',
            marginBottom: '32px',
            whiteSpace: 'pre-wrap',
            lineHeight: '1.7',
            fontSize: '14px',
            color: '#e2e8f0'
          }}
        >
          <h3
            style={{
              margin: '0 0 12px 0',
              fontSize: '16px',
              color: '#10b981'
            }}
          >
            📌 AI 대화 요약
          </h3>

          {verificationResult?.summary}
        </div>

        {/* 2차 가설 */}
        <label
          style={{
            display: 'block',
            fontWeight: '600',
            marginBottom: '8px'
          }}
        >
          수정된 2차 가설
        </label>

        <textarea
          style={{
            width: '100%',
            height: '90px',
            padding: '14px',
            borderRadius: '12px',
            border: '1px solid #475569',
            backgroundColor: '#0f172a',
            color: '#fff',
            fontSize: '15px',
            boxSizing: 'border-box',
            marginBottom: '20px'
          }}
          placeholder="최종 가설을 작성하세요."
          value={revisedHypothesis}
          onChange={e => setRevisedHypothesis(e.target.value)}
          disabled={isCompleted}
        />

        {/* 2차 절차 */}
        <label
          style={{
            display: 'block',
            fontWeight: '600',
            marginBottom: '8px'
          }}
        >
          수정된 2차 실험 절차
        </label>

        <textarea
          style={{
            width: '100%',
            height: '200px',
            padding: '14px',
            borderRadius: '12px',
            border: '1px solid #475569',
            backgroundColor: '#0f172a',
            color: '#fff',
            fontSize: '15px',
            boxSizing: 'border-box',
            marginBottom: '24px'
          }}
          placeholder="최종 실험 절차를 작성하세요."
          value={revisedProcedure}
          onChange={e => setRevisedProcedure(e.target.value)}
          disabled={isCompleted}
        />

        <div
          style={{
            display: 'flex',
            gap: '16px'
          }}
        >
          <button
            style={{
              flex: 1,
              padding: '14px',
              borderRadius: '12px',
              border: '1px solid #475569',
              backgroundColor: 'transparent',
              color: '#94a3b8',
              cursor: 'pointer'
            }}
            onClick={async () => {
              await saveProgress(3);
              setStep(3);
            }}
          >
            ◀ 대화 다시 보기
          </button>

          {!isCompleted ? (
            <button
              style={{
                flex: 2,
                padding: '14px',
                borderRadius: '12px',
                border: 'none',
                backgroundColor: '#10b981',
                color: '#fff',
                fontWeight: '700',
                fontSize: '16px',
                cursor: 'pointer'
              }}
              onClick={handleSaveFinal}
            >
              💾 2차 탐구 설계서 최종 저장하기
            </button>
          ) : (
            <div
              style={{
                flex: 2,
                padding: '14px',
                borderRadius: '12px',
                backgroundColor: '#065f46',
                color: '#34d399',
                textAlign: 'center',
                fontWeight: '700'
              }}
            >
              ✓ 최종 탐구 설계서 저장이 완료되었습니다.
            </div>
          )}
        </div>
      </div>
    );
  }

  return null;
}
