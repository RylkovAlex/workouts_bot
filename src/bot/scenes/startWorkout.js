const {
  Scenes: { WizardScene },
} = require('telegraf');

const { Answer } = require('../../models/answer');
const { Session } = require('../../models/session');
const keyboardMarkup = require('../keyboards/keyboards');
const buttons = require('../keyboards/buttons');
const answerTypes = require('../enums/answerTypes');
const scenes = require('../enums/scenes');

const basicSceneKeyboard = keyboardMarkup.make([
  [buttons.back, buttons.next],
  [buttons.cancel],
]);

const enterHandler = async (ctx) => {
  const { workout } = ctx.scene.state;

  ctx.scene.state = {
    ...ctx.scene.state,
    result: {
      answers: [],
    },
  };

  const handlers = getStartWorkoutHandlers(workout);
  handlers.push((ctx) => {
    ctx.scene.leave();
  });

  startWorkout.steps.splice(1, startWorkout.steps.length);
  startWorkout.steps.push(...handlers);

  ctx.wizard.next();

  return ctx.wizard.steps[ctx.wizard.cursor](ctx);
};

const startWorkout = new WizardScene(`startWorkout`, enterHandler);

startWorkout.leave(async (ctx) => {
  try {
    if (ctx.message.text === buttons.cancel) {
      await ctx.reply(
        `Тренировочная сессия отменена! Доступные тренировки:`,
        keyboardMarkup.remove()
      );
      return ctx.scene.enter(scenes.chouseWorkout);
    }
    await ctx.reply(
      `Сохраняю результат тренировки...`,
      keyboardMarkup.remove()
    );
    const { workout, result } = ctx.scene.state;
    const { answers, time } = result;
    const session = {
      answers,
      workout: workout._id,
    };
    if (workout.params.time) {
      session.time = time;
    }

    const spreadSheet = await ctx.getSpreadSheet();
    await new Session(session)
      .save()
      .then((session) => spreadSheet.addSession(session));

    await ctx.reply(`Отлично! Тренировочная сессия сохранена.`);
    return ctx.scene.enter(scenes.chouseWorkout);
  } catch (error) {
    ctx.handleError(error);
  }
});

startWorkout.hears(buttons.back, (ctx) => {
  const step = ctx.wizard.cursor - 3;
  if (step > 0) {
    ctx.wizard.selectStep(step);
    return ctx.wizard.steps[ctx.wizard.cursor](ctx);
  }
  ctx.wizard.back();
  return ctx.wizard.steps[ctx.wizard.cursor](ctx);
});

module.exports = startWorkout;

// SCENE HANDLERS:

function getStartWorkoutHandlers(workout) {
  const { time, before, after } = workout.params;
  const handlers = [];

  before.forEach((q) => handlers.push(...getQuestionHandlers(q)));
  handlers.push(...getTimeHandlers(time));
  after.forEach((q) => handlers.push(...getQuestionHandlers(q)));

  return handlers;
}

function getQuestionHandlers(q) {
  const { question, answerType, possibleAnswers, _id: questionId } = q;

  const questionHandler = async (ctx) => {
    if (
      answerType === answerTypes.STRING ||
      answerType === answerTypes.NUMBER
    ) {
      await ctx.reply(question, basicSceneKeyboard);
    } else {
      const keyboard = keyboardMarkup.combineAndMake(possibleAnswers, {
        cancel: true,
        next: true,
        back: true,
      });
      await ctx.reply(question, keyboard);
    }

    if (answerType === answerTypes.MULTIPLE) {
      ctx.scene.state.result.answers.push(
        new Answer({
          question: questionId,
          answer: [],
        })
      );
    }

    return ctx.wizard.next();
  };

  const answerHandler = async (ctx) => {
    const answer = ctx.message.text.trim();
    if (answer === buttons.next) {
      ctx.wizard.next();
      return ctx.wizard.steps[ctx.wizard.cursor](ctx);
    }
    const { answers } = ctx.scene.state.result;

    switch (answerType) {
      case answerTypes.STRING: {
        answers.push(
          new Answer({
            question: questionId,
            answer,
          })
        );
        ctx.wizard.next();
        break;
      }

      case answerTypes.NUMBER: {
        const number = Number(answer.replace(/,/g, '.'));
        if (isNaN(number)) {
          return ctx.reply(
            `Параметром должно быть число. Попробуем ещё раз. \n${question}`,
            basicSceneKeyboard
          );
        } else {
          answers.push(
            new Answer({
              question: questionId,
              answer: number,
            })
          );
          ctx.wizard.next();
          break;
        }
      }

      case answerTypes.MULTIPLE: {
        const givenAnswers = answers.find(
          (a) => a.question === questionId
        ).answer;

        if (possibleAnswers.includes(answer)) {
          givenAnswers.push(answer);
          const updatedPossibleAnswers = possibleAnswers.filter(
            (a) => !givenAnswers.includes(a)
          );

          return ctx.reply(
            `Можно выбрать несколько вариантов или нажать "далее" для продолжения`,
            keyboardMarkup.combineAndMake(updatedPossibleAnswers, {
              cancel: true,
              next: true,
              back: true,
            })
          );
        }

        return ctx.reply(
          `Введён неверный ответ. Выберите один из вариантов: \n`,
          keyboardMarkup.combineAndMake(possibleAnswers, {
            cancel: true,
            next: true,
            back: true,
          })
        );
      }

      case answerTypes.RADIO: {
        if (possibleAnswers.includes(answer)) {
          answers.push(
            new Answer({
              question: questionId,
              answer,
            })
          );
          ctx.wizard.next();
          break;
        }
        return ctx.reply(
          `Введён неверный ответ. Выберите один из вариантов: \n`,
          keyboardMarkup.combineAndMake(possibleAnswers, {
            cancel: true,
            next: true,
            back: true,
          })
        );
      }

      default:
        throw new Error(`Wrong answer type: ${answerType}`);
    }
    return ctx.wizard.steps[ctx.wizard.cursor](ctx);
  };

  return [questionHandler, answerHandler];
}

function getTimeHandlers(time) {
  if (!time) {
    const firstHandler = async (ctx) => {
      await ctx.reply(
        `Тренировочная сессия запущена. После тренировки нажмите ${buttons.next}`,
        basicSceneKeyboard
      );
      return ctx.wizard.next();
    };
    const secondHandler = (ctx) => {
      const text = ctx.message.text.trim();
      if (text === buttons.next) {
        ctx.wizard.next();
        return ctx.wizard.steps[ctx.wizard.cursor](ctx);
      } else {
        return ctx.reply(
          `Тренирока в процессе. После тренировки нажмите ${buttons.next}`,
          basicSceneKeyboard
        );
      }
    };
    return [firstHandler, secondHandler];
  }

  const firstHandler = async (ctx) => {
    ctx.scene.state.startTime = Date.now();
    await ctx.reply(
      `Тренировочная сессия запущена, идёт отсчёт времени! После тренировки вернитесь в чат и нажмите ${buttons.next}`,
      basicSceneKeyboard
    );
    return ctx.wizard.next();
  };
  const secondHandler = async (ctx) => {
    const text = ctx.message.text.trim();

    if (text === buttons.next) {
      const { startTime } = ctx.scene.state;
      const finishTime = Date.now();
      const time = Math.floor((finishTime - startTime) / 60000);
      console.log(time);
      ctx.scene.state.result.time = time;
      ctx.wizard.next();
      return ctx.wizard.steps[ctx.wizard.cursor](ctx);
    } else {
      return ctx.reply(
        `Тренирока в процессе. После тренировки нажмите ${buttons.next}`,
        basicSceneKeyboard
      );
    }
  };

  return [firstHandler, secondHandler];
}
