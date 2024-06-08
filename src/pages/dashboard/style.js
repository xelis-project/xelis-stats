import { css } from 'goober'
import theme from 'xelis-explorer/src/style/theme'

export default {
  header: {
    container: css`
      display: flex;
      flex-direction: column;
      align-items: center;
      margin: 2em 0 3em 0;
      gap: 1em;
    `,
    logo: css`
    width: 3em;
    height: 3em;
    display: block;
    background-size: contain;
    background-repeat: no-repeat;
    background-image: ${theme.apply({ xelis: `url('public/img/white_background_black_logo.svg')`, light: `url('public/img/black_background_white_logo.svg')`, dark: `url('public/img/white_background_black_logo.svg')`, })};
    `,
    title: css`
      font-size: 2.5em;
      font-weight: bold;
    `,
    description: css`
      max-width: 27em;
      text-align: center;
      opacity: .9;
    `,
    autoUpdate: css`
      background: rgb(0 0 0 / 30%);
      padding: 0.5em 1em;
      border-radius: 0.5em;
      opacity: .8;
      margin: 0 auto;
      width: 12em;
      text-align: center;
      color: var(--text-color);
    `
  },
  topStats: {
    container: css`
      padding: 1em;
      margin-bottom: 2em;
      background-color: ${theme.apply({ xelis: ` rgb(0 0 0 / 50%)`, dark: ` rgb(0 0 0 / 50%)`, light: ` rgb(255 255 255 / 50%)` })};
      border-radius: 0.5em;
      color: var(--text-color);
      display: flex;
      gap: 2.5em;
      overflow: auto;
      justify-content: space-between;
    `,
    item: {
      container: css`
        display: flex;
        gap: .3em;
        flex-direction: column;
      `,
      title: css`
        font-size: .9em;
        opacity: .6;
        white-space: nowrap;
        margin-bottom: .1em;
      `,
      value: css`
        font-size: 1.5em;
        white-space: nowrap;
      `
    },
    loading: css`
      opacity: .6;
    `
  },
  sections: {
    container: css`
      display: flex;
      gap: 2em;
      flex-direction: column;
    `,
    title: css`
      font-weight: bold;
      font-size: 1.8em;
      display: flex;
      gap: .5em;
      align-items: center;
    `,
    item: css`
        display: flex;
        gap: 1.5em;
        flex-direction: column;
      `,
    boxes: css`
      display: flex;
      gap: 1em;
      overflow-x: scroll;
      padding-bottom: 1em;
    `
  }
}