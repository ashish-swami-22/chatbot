type Props = {
  params: { id: string };
};

export default function ConversationPage({ params }: Props) {
  const { id } = params;

  return (
    <main>
      <h1>Conversation {id}</h1>
      <p>Resume an existing conversation here.</p>
    </main>
  );
}
