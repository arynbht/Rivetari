const SECTION = /§\s*\d+(?:\.\d+)*/;

export default {
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Comments don't cite numbered spec sections: specs get renumbered and the citations drift apart",
    },
    messages: {
      section:
        "Don't cite spec section {{section}} in a comment: sections get renumbered, and two citations of one rule end up disagreeing. Say the rule itself.",
    },
    schema: [],
  },
  create(context) {
    return {
      Program() {
        for (const comment of context.sourceCode.getAllComments()) {
          const match = SECTION.exec(comment.value);
          if (match)
            context.report({
              loc: comment.loc,
              messageId: "section",
              data: { section: match[0].replace(/\s+/g, "") },
            });
        }
      },
    };
  },
};
